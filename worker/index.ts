import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnvironment, OperatorRole, OrderRow } from "./types";
import { ApiError, createId, createRandomToken, normalizeDigits, sha256 } from "./utils";
import { createOperatorSession, createPasswordCredential, optionalAuthentication, requireRoles, revokeCurrentSession, verifyPasswordCredential } from "./auth";
import { createPaymentOrder, expireReservations, getOrderView, markOrderPaid, reconcileOrderPayment } from "./services/orders";
import { redeemCourtesy } from "./services/courtesies";
import { redeemTicket } from "./services/tickets";
import {
  adjustInventory,
  createCampaign,
  createProduct,
  createDeviceActivation,
  getDashboard,
  getHealth,
  getOperationalReport,
  operationalReportCsv,
  setCampaignActive,
  setProductActive,
  updateProductPrice
} from "./services/admin";
import { createPaymentProvider } from "./payments/pagbank";
import { verifyPagBankWebhook } from "./payments/webhook";
import { adjustVolumeStock, configureStock, type StockInput } from './services/stock';
import { acknowledgeAlert, dispatchStockPush, getAlerts, recordPushReceipt, subscribePush } from './services/alerts';
import { scannerLink, joinScanner, team, listOrders, pareto } from './services/management';

const app = new Hono<AppEnvironment>();

app.use("/api/*", secureHeaders());
app.use("/api/*", optionalAuthentication);

app.onError((error, context) => {
  if (error instanceof ApiError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  console.error("Unhandled API error", error);
  return context.json({ error: { code: "INTERNAL_ERROR", message: "Não foi possível concluir agora. Tente novamente." } }, 500);
});

app.notFound(context => context.json({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }, 404));

app.get("/api/catalog", async context => {
  const event = await context.env.DB.prepare(`
    SELECT id, slug, name, subtitle, starts_at, ends_at, catalog_version
    FROM events WHERE slug = ? AND active = 1
  `).bind(context.env.EVENT_SLUG).first<Record<string, unknown>>();
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "O evento não está disponível.");
  const products = (await context.env.DB.prepare(`
    SELECT p.id, p.slug, p.name, p.description, p.emoji, p.color, p.unit_price_cents,
      i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity AS available_quantity
    FROM products p JOIN inventory i ON i.product_id = p.id AND i.event_id = p.event_id
    WHERE p.event_id = ? AND p.active = 1 ORDER BY p.sort_order
  `).bind(event.id).all<Record<string, unknown>>()).results;
  return context.json({ event, products }, 200, { "Cache-Control": "no-store" });
});

app.post("/api/orders", async context => {
  const body = await context.req.json<Record<string, unknown>>();
  const customer = (body.customer ?? {}) as Record<string, string>;
  const order = await createPaymentOrder(context.env, {
    eventSlug: context.env.EVENT_SLUG,
    idempotencyKey: String(body.idempotencyKey ?? ""),
    accessToken: String(body.accessToken ?? ""),
    customer: {
      name: String(customer.name ?? ""),
      phone: normalizeDigits(customer.phone),
      taxId: normalizeDigits(customer.taxId)
    },
    items: Array.isArray(body.items) ? body.items.map(item => {
      const record = item as Record<string, unknown>;
      return { productId: String(record.productId ?? ""), quantity: Number(record.quantity) };
    }) : []
  });
  return context.json(order, 201);
});

function getOrderAccessToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "ORDER_TOKEN_REQUIRED", "O link privado do pedido está incompleto.");
  return match[1];
}

app.get("/api/orders/:publicId", async context => {
  return context.json(await getOrderView(context.env, context.req.param("publicId"), getOrderAccessToken(context.req.header("Authorization"))));
});

app.post("/api/orders/:publicId/refresh", async context => {
  const accessToken = getOrderAccessToken(context.req.header("Authorization"));
  await getOrderView(context.env, context.req.param("publicId"), accessToken);
  const order = await context.env.DB.prepare("SELECT * FROM orders WHERE public_id = ?")
    .bind(context.req.param("publicId")).first<OrderRow>();
  if ((order?.status === "PENDING_PAYMENT" || order?.status === "EXPIRED") && order.provider_order_id) {
    const status = await createPaymentProvider(context.env).getPaymentStatus(order.provider_order_id);
    await reconcileOrderPayment(context.env, order, status);
  }
  return context.json(await getOrderView(context.env, context.req.param("publicId"), accessToken));
});

app.post("/api/courtesies/redeem", async context => {
  const body = await context.req.json<Record<string, unknown>>();
  const result = await redeemCourtesy(context.env, {
    eventSlug: context.env.EVENT_SLUG,
    code: String(body.code ?? ""),
    idempotencyKey: String(body.idempotencyKey ?? ""),
    accessToken: String(body.accessToken ?? "")
  });
  return context.json(await getOrderView(context.env, result.publicId, String(body.accessToken)), 201);
});

app.post("/api/tickets/redeem", requireRoles("ADMIN", "BARTENDER", "EVENTOS"), async context => {
  const body = await context.req.json<{ token?: string }>();
  return context.json(await redeemTicket(context.env, context.get("operator")!, String(body.token ?? "")));
});

app.post("/api/webhooks/pagbank", async context => {
  const rawBody = await context.req.text();
  const signatures = (context.req.header("x-payload-signature") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!await verifyPagBankWebhook(context.env, rawBody, signatures)) throw new ApiError(401, "INVALID_WEBHOOK", "Assinatura inválida.");
  const payloadHash = await sha256(rawBody);
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const charge = ((payload.charges as Array<Record<string, unknown>> | undefined)?.[0] ?? payload) as Record<string, unknown>;
  const providerOrderId = String(payload.id ?? "");
  const providerChargeId = String(charge.id ?? "");
  const status = String(charge.status ?? "UNKNOWN").toUpperCase();
  const eventKey = `${providerOrderId || providerChargeId}:${status}:${String(payload.updated_at ?? charge.updated_at ?? payloadHash)}`;
  try {
    await context.env.DB.prepare(`
      INSERT INTO webhook_events (id, provider, event_key, payload_hash, status)
      VALUES (?, 'PAGBANK', ?, ?, 'RECEIVED')
    `).bind(createId("whk"), eventKey, payloadHash).run();
  } catch {
    const previous = await context.env.DB.prepare("SELECT status FROM webhook_events WHERE event_key = ?")
      .bind(eventKey).first<{ status: string }>();
    if (previous?.status === "PROCESSED") return context.json({ received: true, duplicate: true });
    await context.env.DB.prepare("UPDATE webhook_events SET status = 'RECEIVED', error_message = NULL WHERE event_key = ?")
      .bind(eventKey).run();
  }
  const referenceId = String(payload.reference_id ?? charge.reference_id ?? "");
  const order = await context.env.DB.prepare(`
    SELECT * FROM orders WHERE id = ? OR provider_order_id = ? OR provider_charge_id = ? LIMIT 1
  `).bind(referenceId, providerOrderId, providerChargeId).first<OrderRow>();
  if (!order) {
    await context.env.DB.prepare("UPDATE webhook_events SET status = 'IGNORED', processed_at = CURRENT_TIMESTAMP WHERE event_key = ?").bind(eventKey).run();
    return context.json({ received: true, ignored: true });
  }
  try {
    if (!order.provider_order_id) throw new ApiError(409, "PAYMENT_ORDER_MISSING", "O pedido ainda nÃ£o tem uma referÃªncia de pagamento.");
    const confirmedPayment = await createPaymentProvider(context.env).getPaymentStatus(order.provider_order_id);
    await reconcileOrderPayment(context.env, order, confirmedPayment);
    await context.env.DB.prepare("UPDATE webhook_events SET status = 'PROCESSED', processed_at = CURRENT_TIMESTAMP WHERE event_key = ?")
      .bind(eventKey).run();
    return context.json({ received: true, status: confirmedPayment.status });
  } catch (error) {
    await context.env.DB.prepare("UPDATE webhook_events SET status = 'FAILED', error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE event_key = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Falha ao reconciliar pagamento", eventKey).run();
    throw error;
  }
});

app.post("/api/staff/bootstrap", async context => {
  const existing = await context.env.DB.prepare("SELECT COUNT(*) AS total FROM admin_credentials").first<{ total: number }>();
  if ((existing?.total ?? 0) > 0) throw new ApiError(409, "BOOTSTRAP_ALREADY_USED", "O administrador inicial já foi criado.");
  const body = await context.req.json<{ displayName?: string; deviceLabel?: string; username?: string; password?: string }>();
  const event = await context.env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(context.env.EVENT_SLUG).first<{ id: string }>();
  const username = body.username?.trim().toLowerCase() ?? "";
  if (!event || !body.displayName?.trim() || !/^[a-z0-9._-]{3,40}$/.test(username)) throw new ApiError(400, "INVALID_BOOTSTRAP", "Informe nome e usuário válidos.");
  if (body.password !== undefined && body.password.length > 128) throw new ApiError(400, "INVALID_PASSWORD", "A senha deve ter entre 10 e 128 caracteres.");
  const credential = await createPasswordCredential(body.password ?? "");
  const currentAdmin = await context.env.DB.prepare("SELECT id FROM operators WHERE event_id = ? AND role = 'ADMIN' AND active = 1 ORDER BY created_at LIMIT 1")
    .bind(event.id).first<{ id: string }>();
  const operatorId = currentAdmin?.id ?? createId("opr");
  const bootstrapStatements: D1PreparedStatement[] = [];
  if (!currentAdmin) {
    bootstrapStatements.push(context.env.DB.prepare("INSERT INTO operators (id, event_id, display_name, role) VALUES (?, ?, ?, 'ADMIN')")
      .bind(operatorId, event.id, body.displayName.trim().slice(0, 100)));
  }
  bootstrapStatements.push(context.env.DB.prepare(`
    INSERT INTO admin_credentials (id, event_id, operator_id, username, password_salt, password_hash, password_iterations)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(createId("cred"), event.id, operatorId, username, credential.salt, credential.hash, credential.iterations));
  try {
    await context.env.DB.batch(bootstrapStatements);
  } catch {
    throw new ApiError(409, "BOOTSTRAP_ALREADY_USED", "A conta administrativa inicial já foi criada.");
  }
  await createOperatorSession(context, operatorId, event.id, body.deviceLabel?.trim() || "Administrador principal");
  return context.json({ ok: true }, 201);
});

app.post("/api/staff/login", async context => {
  const body = await context.req.json<{ username?: string; password?: string; deviceLabel?: string }>();
  const username = body.username?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const ipAddress = context.req.header("CF-Connecting-IP") ?? context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
  const ipHash = await sha256(ipAddress);
  const recentFailures = await context.env.DB.prepare(`
    SELECT COUNT(*) AS total FROM staff_login_attempts
    WHERE ip_hash = ? AND success = 0 AND attempted_at > datetime('now', '-15 minutes')
  `).bind(ipHash).first<{ total: number }>();
  if ((recentFailures?.total ?? 0) >= 5) throw new ApiError(429, "LOGIN_RATE_LIMIT", "Muitas tentativas. Aguarde 15 minutos.");
  const credential = await context.env.DB.prepare(`
    SELECT c.operator_id, c.event_id, c.password_salt, c.password_hash, c.password_iterations
    FROM admin_credentials c JOIN operators o ON o.id = c.operator_id
    WHERE c.username = ? COLLATE NOCASE AND o.active = 1
  `).bind(username).first<{ operator_id: string; event_id: string; password_salt: string; password_hash: string; password_iterations: number }>();
  const valid = credential
    ? await verifyPasswordCredential(password, credential.password_salt, credential.password_hash, credential.password_iterations)
    : false;
  await context.env.DB.prepare("INSERT INTO staff_login_attempts (id, ip_hash, success) VALUES (?, ?, ?)")
    .bind(createId("login"), ipHash, valid ? 1 : 0).run();
  if (!credential || !valid) throw new ApiError(401, "INVALID_LOGIN", "Usuário ou senha inválidos.");
  await createOperatorSession(context, credential.operator_id, credential.event_id, body.deviceLabel?.trim() || "Acesso administrativo");
  return context.json({ ok: true });
});

app.post("/api/staff/activate", async context => {
  const body = await context.req.json<{ token?: string; deviceLabel?: string; displayName?: string; reader?: boolean }>();
  if (body.reader) {
    const member = await joinScanner(context.env, String(body.token ?? ''), String(body.displayName ?? ''));
    await createOperatorSession(context, member.id, member.eventId, body.deviceLabel?.trim() || 'Leitura no celular');
    return context.json({ok:true});
  }
  const tokenHash = await sha256(String(body.token ?? ""));
  const activation = await context.env.DB.prepare(`
    SELECT a.id, a.event_id, a.operator_id FROM activation_tokens a
    JOIN operators o ON o.id = a.operator_id
    WHERE a.token_hash = ? AND a.used_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > CURRENT_TIMESTAMP AND o.active = 1
  `).bind(tokenHash).first<{ id: string; event_id: string; operator_id: string }>();
  if (!activation) throw new ApiError(404, "ACTIVATION_INVALID", "Ativação inválida, expirada ou já utilizada.");
  const claimed = await context.env.DB.prepare("UPDATE activation_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL")
    .bind(activation.id).run();
  if ((claimed.meta.changes ?? 0) !== 1) throw new ApiError(409, "ACTIVATION_ALREADY_USED", "Esta ativação acabou de ser utilizada.");
  await createOperatorSession(context, activation.operator_id, activation.event_id, body.deviceLabel?.trim() || "Aparelho da equipe");
  return context.json({ ok: true });
});

app.get("/api/staff/me", async context => {
  const operator = context.get("operator");
  if (operator) return context.json({ authenticated: true, operator, setupRequired: false });
  const credentials = await context.env.DB.prepare("SELECT COUNT(*) AS total FROM admin_credentials").first<{ total: number }>();
  return context.json({ authenticated: false, setupRequired: (credentials?.total ?? 0) === 0 });
});

app.post("/api/staff/logout", requireRoles("ADMIN", "MARKETING", "BARTENDER", "EVENTOS"), async context => {
  await revokeCurrentSession(context);
  return context.json({ ok: true });
});

app.get("/api/admin/dashboard", requireRoles("ADMIN", "MARKETING"), async context => {
  return context.json(await getDashboard(context.env, context.get("operator")!.eventId));
});

app.get("/api/admin/reports", requireRoles("ADMIN"), async context => {
  return context.json(await getOperationalReport(context.env, context.get("operator")!.eventId), 200, { "Cache-Control": "no-store" });
});

app.post('/api/admin/scanner-links', requireRoles('ADMIN'), async c => c.json(await scannerLink(c.env,c.get('operator')!),201));
app.get('/api/admin/team', requireRoles('ADMIN'), async c => c.json({members:await team(c.env,c.get('operator')!.eventId)},200,{'Cache-Control':'no-store'}));
app.get('/api/admin/order-search', requireRoles('ADMIN'), async c => {
  const page=Math.max(1,Math.min(10000,Math.floor(Number(c.req.query('page'))||1)));
  return c.json(await listOrders(c.env,c.get('operator')!.eventId,c.req.query('q')??'',page,c.req.query('payments')==='1'),200,{'Cache-Control':'no-store'});
});
app.post('/api/visits', async c => {
  const body=await c.req.json<{visitorId?:string}>();
  if (!/^[a-zA-Z0-9_-]{20,80}$/.test(body.visitorId??'')) throw new ApiError(400,'INVALID_VISITOR','Identificador inválido.');
  const event=await c.env.DB.prepare('SELECT id FROM events WHERE slug=? AND active=1').bind(c.env.EVENT_SLUG).first<{id:string}>();
  if (!event) throw new ApiError(404,'EVENT_NOT_FOUND','Evento indisponível.');
  await c.env.DB.prepare(`INSERT INTO event_visitors (event_id,visitor_hash) VALUES (?,?)
    ON CONFLICT(event_id,visitor_hash) DO UPDATE SET last_seen=CURRENT_TIMESTAMP`).bind(event.id,await sha256(body.visitorId!)).run();
  return c.json({ok:true});
});
app.get('/api/admin/analytics',requireRoles('ADMIN'),async c=>{
  const eventId=c.get('operator')!.eventId;
  const report=await getOperationalReport(c.env,eventId);
  const access=await c.env.DB.prepare('SELECT COUNT(*) AS browsers,MIN(first_seen) AS since FROM event_visitors WHERE event_id=?').bind(eventId).first();
  const hourly=(await c.env.DB.prepare(`SELECT strftime('%Y-%m-%d %H:00',datetime(COALESCE(paid_at,created_at),'-3 hours')) AS hour,
    COUNT(*) AS orders,SUM(amount_cents) AS revenue FROM orders WHERE event_id=? AND kind='PAYMENT' AND status='PAID'
    GROUP BY hour ORDER BY hour`).bind(eventId).all()).results;
  return c.json({summary:report.summary,products:report.salesByProduct,pareto:pareto(report.salesByProduct),access,hourly,
    averageTicket:report.summary.paidOrders?Math.round(report.summary.revenueCents/report.summary.paidOrders):0},200,{'Cache-Control':'no-store'});
});
app.get('/api/admin/documents',requireRoles('ADMIN'),async c=>c.json({documents:(await c.env.DB.prepare(`SELECT d.id,d.kind,d.title,d.url,d.created_at AS createdAt,o.public_id AS orderNumber
  FROM event_documents d LEFT JOIN orders o ON o.id=d.order_id WHERE d.event_id=? ORDER BY d.created_at DESC`)
  .bind(c.get('operator')!.eventId).all()).results},200,{'Cache-Control':'no-store'}));
app.post('/api/admin/documents',requireRoles('ADMIN'),async c=>{
  const body=await c.req.json<{title?:string;url?:string;kind?:string;orderNumber?:string}>();
  let url:URL;
  try {url=new URL(body.url??'');} catch {throw new ApiError(400,'INVALID_URL','Informe um link HTTPS válido.');}
  if(url.protocol!=='https:' || url.username || url.password || (body.url?.length??0)>2000 || !body.title?.trim() || body.title.length>150 || !['FISCAL','LEGAL'].includes(body.kind??''))
    throw new ApiError(400,'INVALID_DOCUMENT','Confira o título, tipo e link HTTPS.');
  const operator=c.get('operator')!;
  const order=body.orderNumber?await c.env.DB.prepare(`SELECT id FROM orders WHERE event_id=? AND public_id=? AND kind='PAYMENT' AND status='PAID'`).bind(operator.eventId,body.orderNumber).first<{id:string}>():null;
  if ((body.orderNumber || body.kind==='FISCAL') && !order) throw new ApiError(400,'INVALID_DOCUMENT_ORDER','Vincule o documento fiscal ao número de um pedido pago.');
  await c.env.DB.prepare('INSERT INTO event_documents (id,event_id,order_id,kind,title,url,created_by) VALUES (?,?,?,?,?,?,?)')
    .bind(createId('doc'),operator.eventId,order?.id??null,body.kind!,body.title.trim(),url.href,operator.id).run();
  return c.json({ok:true},201);
});

app.get("/api/admin/reports/csv", requireRoles("ADMIN"), async context => {
  const report = await getOperationalReport(context.env, context.get("operator")!.eventId);
  const csv = operationalReportCsv(report, "general");
  return context.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"lunaticos-relatorio-geral.csv\"",
    "Cache-Control": "no-store"
  });
});

app.get("/api/admin/health", requireRoles("ADMIN"), async context => {
  return context.json(await getHealth(context.env, context.get("operator")!.eventId));
});

app.post("/api/admin/products/:productId/stock", requireRoles("ADMIN"), async context => {
  const body = await context.req.json<{ quantity?: number; volumeAmount?: number; reason?: string }>();
  const product = await context.env.DB.prepare('SELECT stock_unit FROM products WHERE id = ? AND event_id = ?')
    .bind(context.req.param('productId'), context.get('operator')!.eventId).first<{ stock_unit: string }>();
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Bebida não encontrada.');
  if (product.stock_unit === 'UNIT') await adjustInventory(context.env, context.get("operator")!, context.req.param("productId"), Number(body.quantity), String(body.reason ?? ""));
  else await adjustVolumeStock(context.env, context.get('operator')!, context.req.param('productId'), Number(body.volumeAmount), String(body.reason ?? ''));
  return context.json({ ok: true });
});

app.post('/api/admin/products/:productId/stock-settings', requireRoles('ADMIN'), async context => {
  await configureStock(context.env, context.get('operator')!, context.req.param('productId'), await context.req.json<StockInput>());
  return context.json({ ok: true });
});
app.get('/api/admin/stock-alerts', requireRoles('ADMIN'), async context => context.json(await getAlerts(context.env, context.get('operator')!), 200, { 'Cache-Control': 'no-store' }));
app.post('/api/admin/stock-alerts/:id/acknowledge', requireRoles('ADMIN'), async context => {
  await acknowledgeAlert(context.env, context.get('operator')!, context.req.param('id'));
  return context.json({ ok: true });
});
app.post('/api/admin/push-subscriptions', requireRoles('ADMIN'), async context => {
  await subscribePush(context.env, context.get('operator')!, await context.req.json());
  return context.json({ ok: true });
});
app.post('/api/admin/push-receipts', requireRoles('ADMIN'), async context => {
  const body = await context.req.json<{ alertId?: string }>();
  await recordPushReceipt(context.env, context.get('operator')!, String(body.alertId ?? ''));
  return context.json({ ok: true });
});
app.post('/api/admin/push-subscriptions/disable', requireRoles('ADMIN'), async context => {
  await context.env.DB.prepare('UPDATE push_subscriptions SET enabled = 0 WHERE session_id = ? AND event_id = ?')
    .bind(context.get('operator')!.sessionId, context.get('operator')!.eventId).run();
  return context.json({ ok: true });
});

app.post("/api/admin/products/:productId/active", requireRoles("ADMIN"), async context => {
  const body = await context.req.json<{ active?: boolean }>();
  await setProductActive(context.env, context.get("operator")!, context.req.param("productId"), Boolean(body.active));
  return context.json({ ok: true });
});

app.post("/api/admin/products", requireRoles("ADMIN"), async context => {
  const body = await context.req.json<{ name?: string; description?: string; price?: number; initialQuantity?: number } & StockInput>();
  const product = await createProduct(context.env, context.get("operator")!, {
    name: String(body.name ?? ""), description: String(body.description ?? ""),
    unitPriceCents: Math.round(Number(body.price) * 100), initialQuantity: Number(body.initialQuantity),
    stock: body.stockAmount === undefined ? undefined : body
  });
  return context.json(product, 201);
});

app.post("/api/admin/products/:productId/price", requireRoles("ADMIN"), async context => {
  const body = await context.req.json<{ price?: number }>();
  await updateProductPrice(context.env, context.get("operator")!, context.req.param("productId"), Math.round(Number(body.price) * 100));
  return context.json({ ok: true });
});

app.post("/api/admin/campaigns", requireRoles("ADMIN", "MARKETING"), async context => {
  const body = await context.req.json<{
    name: string; code: string; productId: string; totalLimit: number; quantityPerUse: number; startsAt: string; expiresAt: string;
  }>();
  return context.json(await createCampaign(context.env, context.get("operator")!, body), 201);
});

app.post("/api/admin/campaigns/:campaignId/status", requireRoles("ADMIN", "MARKETING"), async context => {
  const body = await context.req.json<{ active?: boolean }>();
  if (typeof body.active !== "boolean") throw new ApiError(400, "INVALID_CAMPAIGN_STATUS", "Informe se o cupom deve ficar ativo.");
  await setCampaignActive(context.env, context.get("operator")!, context.req.param("campaignId"), body.active);
  return context.json({ ok: true });
});

app.post("/api/admin/devices", requireRoles("ADMIN"), async context => {
  const body = await context.req.json<{ displayName?: string; role?: OperatorRole }>();
  return context.json(await createDeviceActivation(context.env, context.get("operator")!, {
    displayName: String(body.displayName ?? ""),
    role: String(body.role ?? "") as OperatorRole
  }), 201);
});


app.post("/api/dev/mock/orders/:publicId/approve", async context => {
  if (context.env.PAYMENTS_MODE !== "mock") throw new ApiError(404, "NOT_FOUND", "Rota não encontrada.");
  const operator = context.get("operator");
  if (operator?.role !== "ADMIN") throw new ApiError(401, "AUTH_REQUIRED", "Aprovação simulada não autorizada.");
  const order = await context.env.DB.prepare("SELECT * FROM orders WHERE public_id = ?").bind(context.req.param("publicId")).first<OrderRow>();
  if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Pedido não encontrado.");
  await markOrderPaid(context.env, order, "PAID", JSON.stringify({ mock: true, status: "PAID" }));
  return context.json({ ok: true });
});

export default {
  async fetch(request: Request, env: AppEnvironment['Bindings'], executionContext: ExecutionContext) {
    const response = await app.fetch(request, env, executionContext);
    if (new URL(request.url).pathname.startsWith('/api/') && new URL(request.url).pathname !== '/api/visits' && response.ok && (request.method === 'POST' || new URL(request.url).pathname === '/api/admin/stock-alerts'))
      executionContext.waitUntil(dispatchStockPush(env).catch(() => console.error('Stock push dispatch failed')));
    return response;
  },
  async scheduled(_controller: ScheduledController, env: AppEnvironment["Bindings"], executionContext: ExecutionContext) {
    executionContext.waitUntil(Promise.all([
      expireReservations(env, 100).then(() => dispatchStockPush(env)),
      env.DB.prepare("DELETE FROM staff_login_attempts WHERE attempted_at < datetime('now', '-1 day')").run()
    ]).then(() => undefined));
  }
};
