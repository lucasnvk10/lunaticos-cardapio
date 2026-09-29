import type { AuthenticatedOperator, Bindings, OperatorRole } from "../types";
import { ApiError, createId, createRandomToken, isoAfterMinutes, sha256 } from "../utils";
import { calculateStock, type StockInput } from './stock';

export async function getDashboard(bindings: Bindings, eventId: string): Promise<Record<string, unknown>> {
  const summary = await bindings.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'PAID' AND kind = 'PAYMENT' THEN amount_cents ELSE 0 END), 0) AS revenue_cents,
      SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN status = 'PENDING_PAYMENT' THEN 1 ELSE 0 END) AS pending_orders,
      SUM(CASE WHEN status = 'PAYMENT_EXCEPTION' THEN 1 ELSE 0 END) AS payment_exceptions
    FROM orders WHERE event_id = ?
  `).bind(eventId).first<Record<string, number>>();
  const ticketSummary = await bindings.DB.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'USED' THEN 1 ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) AS available
    FROM tickets WHERE event_id = ?
  `).bind(eventId).first<Record<string, number>>();
  const products = (await bindings.DB.prepare(`
    SELECT p.id, p.slug, p.name, p.emoji, p.active, p.unit_price_cents, p.stock_unit, p.portion_ml, p.low_stock_threshold,
      i.initial_volume_ml, i.adjustment_volume_ml,
      i.initial_quantity, i.adjustment_quantity, i.reserved_quantity, i.sold_quantity,
      i.courtesy_quantity, i.redeemed_quantity,
      i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity AS available_quantity,
      i.initial_quantity + i.adjustment_quantity - i.redeemed_quantity AS physical_expected
    FROM products p JOIN inventory i ON i.product_id = p.id AND i.event_id = p.event_id
    WHERE p.event_id = ? ORDER BY p.sort_order
  `).bind(eventId).all<Record<string, unknown>>()).results;
  const campaigns = (await bindings.DB.prepare(`
    SELECT id, name, code_hint, status, total_limit, used_quantity, quantity_per_use, starts_at, expires_at
    FROM courtesy_campaigns WHERE event_id = ? ORDER BY created_at DESC LIMIT 50
  `).bind(eventId).all<Record<string, unknown>>()).results;
  return { summary: summary ?? {}, tickets: ticketSummary ?? {}, products, campaigns };
}

export async function adjustInventory(bindings: Bindings, operator: AuthenticatedOperator, productId: string, quantity: number, reason: string): Promise<void> {
  if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 100_000 || !reason?.trim()) {
    throw new ApiError(400, "INVALID_ADJUSTMENT", "Informe quantidade e motivo válidos.");
  }
  try {
    await bindings.DB.batch([
      bindings.DB.prepare(`
        UPDATE inventory SET adjustment_quantity = adjustment_quantity + ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ? AND product_id = ?
      `).bind(quantity, operator.eventId, productId),
      bindings.DB.prepare(`
        INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reason, operator_id)
        VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?)
      `).bind(createId("mov"), operator.eventId, productId, quantity, reason.trim().slice(0, 300), operator.id),
      bindings.DB.prepare(`
        INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
        VALUES (?, ?, ?, 'ADJUST_INVENTORY', 'PRODUCT', ?, ?)
      `).bind(createId("aud"), operator.eventId, operator.id, productId, JSON.stringify({ quantity, reason: reason.trim() }))
    ]);
  } catch {
    throw new ApiError(409, "INVALID_STOCK_RESULT", "O ajuste deixaria o estoque abaixo do já comprometido.");
  }
}

export async function setProductActive(bindings: Bindings, operator: AuthenticatedOperator, productId: string, active: boolean): Promise<void> {
  await bindings.DB.batch([
    bindings.DB.prepare("UPDATE products SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND id = ?")
      .bind(active ? 1 : 0, operator.eventId, productId),
    bindings.DB.prepare("UPDATE events SET catalog_version = catalog_version + 1 WHERE id = ?").bind(operator.eventId),
    bindings.DB.prepare(`
      INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, 'SET_PRODUCT_ACTIVE', 'PRODUCT', ?, ?)
    `).bind(createId("aud"), operator.eventId, operator.id, productId, JSON.stringify({ active }))
  ]);
}

export async function createProduct(bindings: Bindings, operator: AuthenticatedOperator, input: {
  name: string;
  description?: string;
  unitPriceCents: number;
  initialQuantity: number;
  stock?: StockInput;
}): Promise<{ id: string; slug: string }> {
  const name = input.name?.trim();
  const description = input.description?.trim() ?? "";
  const slug = (name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!name || name.length > 80 || description.length > 240 || !slug || slug.length > 100) {
    throw new ApiError(400, "INVALID_PRODUCT", "Informe nome e descrição válidos para a bebida.");
  }
  if (!Number.isInteger(input.unitPriceCents) || input.unitPriceCents < 1 || input.unitPriceCents > 10_000_000) {
    throw new ApiError(400, "INVALID_PRODUCT_PRICE", "Informe um preço entre R$ 0,01 e R$ 100.000,00.");
  }
  const stock = calculateStock(input.stock ?? { stockUnit: 'UNIT', stockAmount: input.initialQuantity });
  input.initialQuantity = stock.capacity;
  if (!Number.isInteger(input.initialQuantity) || input.initialQuantity < 0 || input.initialQuantity > 100_000) {
    throw new ApiError(400, "INVALID_PRODUCT_STOCK", "Informe o estoque inicial entre 0 e 100.000 unidades.");
  }

  const id = createId("prd");
  const sortOrder = await bindings.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM products WHERE event_id = ?")
    .bind(operator.eventId).first<{ next_order: number }>();
  try {
    await bindings.DB.batch([
      bindings.DB.prepare(`
        INSERT INTO products (id, event_id, slug, name, description, emoji, color, unit_price_cents, sort_order, active, stock_unit, portion_ml, low_stock_threshold)
        VALUES (?, ?, ?, ?, ?, '', '#ff5b00', ?, ?, 1, ?, ?, ?)
      `).bind(id, operator.eventId, slug, name, description, input.unitPriceCents, sortOrder?.next_order ?? 1, stock.unit, stock.portion, stock.threshold),
      bindings.DB.prepare("INSERT INTO inventory (event_id, product_id, initial_quantity, initial_volume_ml) VALUES (?, ?, ?, ?)")
        .bind(operator.eventId, id, input.initialQuantity, stock.volume),
      bindings.DB.prepare(`
        INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reason, operator_id)
        VALUES (?, ?, ?, 'INITIAL', ?, 'Estoque inicial cadastrado com a bebida', ?)
      `).bind(createId("mov"), operator.eventId, id, input.initialQuantity, operator.id),
      bindings.DB.prepare(`
        INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
        VALUES (?, ?, ?, 'CREATE_PRODUCT', 'PRODUCT', ?, ?)
      `).bind(createId("aud"), operator.eventId, operator.id, id, JSON.stringify({ name, slug, unitPriceCents: input.unitPriceCents, initialQuantity: input.initialQuantity })),
      bindings.DB.prepare("UPDATE events SET catalog_version = catalog_version + 1 WHERE id = ?").bind(operator.eventId)
    ]);
  } catch {
    throw new ApiError(409, "PRODUCT_CONFLICT", "Já existe uma bebida com esse nome ou o produto não pôde ser criado.");
  }
  return { id, slug };
}

export async function updateProductPrice(bindings: Bindings, operator: AuthenticatedOperator, productId: string, unitPriceCents: number): Promise<void> {
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 1 || unitPriceCents > 10_000_000) {
    throw new ApiError(400, "INVALID_PRODUCT_PRICE", "Informe um preço entre R$ 0,01 e R$ 100.000,00.");
  }
  const product = await bindings.DB.prepare("SELECT id, unit_price_cents FROM products WHERE event_id = ? AND id = ?")
    .bind(operator.eventId, productId).first<{ id: string; unit_price_cents: number }>();
  if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Bebida não encontrada.");
  await bindings.DB.batch([
    bindings.DB.prepare("UPDATE products SET unit_price_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND id = ?")
      .bind(unitPriceCents, operator.eventId, productId),
    bindings.DB.prepare("UPDATE events SET catalog_version = catalog_version + 1 WHERE id = ?").bind(operator.eventId),
    bindings.DB.prepare(`
      INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, 'UPDATE_PRODUCT_PRICE', 'PRODUCT', ?, ?)
    `).bind(createId("aud"), operator.eventId, operator.id, productId, JSON.stringify({ previousPriceCents: product.unit_price_cents, unitPriceCents }))
  ]);
}

export async function setCampaignActive(bindings: Bindings, operator: AuthenticatedOperator, campaignId: string, active: boolean): Promise<void> {
  const campaign = await bindings.DB.prepare(`
    SELECT id, status, total_limit, used_quantity, expires_at
    FROM courtesy_campaigns WHERE event_id = ? AND id = ?
  `).bind(operator.eventId, campaignId).first<{ id: string; status: string; total_limit: number; used_quantity: number; expires_at: string }>();
  if (!campaign) throw new ApiError(404, "CAMPAIGN_NOT_FOUND", "Cupom não encontrado.");

  const nextStatus = active ? "ACTIVE" : "DISABLED";
  if (active) {
    if (campaign.status !== "DISABLED") throw new ApiError(409, "CAMPAIGN_NOT_REACTIVATABLE", "Só é possível reativar um cupom suspenso.");
    if (campaign.used_quantity >= campaign.total_limit || Date.parse(campaign.expires_at) <= Date.now()) {
      throw new ApiError(409, "CAMPAIGN_EXPIRED", "Este cupom atingiu o limite ou já expirou.");
    }
  } else if (campaign.status !== "ACTIVE") {
    throw new ApiError(409, "CAMPAIGN_NOT_ACTIVE", "Este cupom não está ativo.");
  }

  const updateResult = await bindings.DB.prepare(`
    UPDATE courtesy_campaigns SET status = ? WHERE event_id = ? AND id = ? AND status = ?
  `).bind(nextStatus, operator.eventId, campaignId, campaign.status).run();
  if (!updateResult.meta.changes) throw new ApiError(409, "CAMPAIGN_CHANGED", "O cupom foi alterado por outra pessoa. Atualize a lista.");
  await bindings.DB.prepare(`
    INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, 'SET_CAMPAIGN_STATUS', 'COURTESY_CAMPAIGN', ?, ?)
  `).bind(createId("aud"), operator.eventId, operator.id, campaignId, JSON.stringify({ previousStatus: campaign.status, status: nextStatus })).run();
}

export async function createCampaign(bindings: Bindings, operator: AuthenticatedOperator, input: {
  name: string;
  code: string;
  productId: string;
  totalLimit: number;
  quantityPerUse: number;
  startsAt: string;
  expiresAt: string;
}): Promise<{ id: string; code: string }> {
  const code = input.code.trim().toUpperCase();
  if (!input.name?.trim() || !/^[A-Z0-9-]{4,40}$/.test(code) || !input.productId) {
    throw new ApiError(400, "INVALID_CAMPAIGN", "Revise o nome, código e produtos da campanha.");
  }
  if (!Number.isInteger(input.totalLimit) || input.totalLimit < 1 || !Number.isInteger(input.quantityPerUse) || input.quantityPerUse < 1 || input.quantityPerUse > input.totalLimit) {
    throw new ApiError(400, "INVALID_CAMPAIGN_LIMIT", "Revise os limites da campanha.");
  }
  if (Date.parse(input.expiresAt) <= Date.parse(input.startsAt)) throw new ApiError(400, "INVALID_CAMPAIGN_DATES", "A validade precisa terminar depois do início.");
  const product = await bindings.DB.prepare("SELECT id FROM products WHERE event_id = ? AND id = ? AND active = 1")
    .bind(operator.eventId, input.productId).first<{ id: string }>();
  if (!product) throw new ApiError(400, "INVALID_CAMPAIGN_PRODUCT", "Selecione um produto ativo para o cupom.");
  const id = createId("cmp");
  const statements: D1PreparedStatement[] = [
    bindings.DB.prepare(`
      INSERT INTO courtesy_campaigns (
        id, event_id, name, code_hash, code_hint, status, total_limit, quantity_per_use,
        starts_at, expires_at, created_by_operator_id
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
    `).bind(id, operator.eventId, input.name.trim(), await sha256(code), code.slice(0, 3) + "…", input.totalLimit, input.quantityPerUse, input.startsAt, input.expiresAt, operator.id)
  ];
  statements.push(bindings.DB.prepare("INSERT INTO courtesy_campaign_products (campaign_id, product_id) SELECT ?, id FROM products WHERE event_id = ? AND id = ? AND active = 1").bind(id, operator.eventId, input.productId));
  try {
    await bindings.DB.batch(statements);
  } catch {
    throw new ApiError(409, "CAMPAIGN_CONFLICT", "O código já existe ou algum produto é inválido.");
  }
  return { id, code };
}

export async function createDeviceActivation(bindings: Bindings, operator: AuthenticatedOperator, input: {
  displayName: string;
  role: OperatorRole;
}): Promise<{ activationUrl: string; expiresAt: string }> {
  if (!input.displayName?.trim() || !["ADMIN", "MARKETING", "BARTENDER", "EVENTOS"].includes(input.role)) throw new ApiError(400, "INVALID_OPERATOR", "Revise nome e função.");
  const operatorId = createId("opr");
  const activationId = createId("act");
  const rawToken = createRandomToken();
  const expiresAt = isoAfterMinutes(60 * 24);
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO operators (id, event_id, display_name, role) VALUES (?, ?, ?, ?)")
      .bind(operatorId, operator.eventId, input.displayName.trim().slice(0, 100), input.role),
    bindings.DB.prepare("INSERT INTO activation_tokens (id, event_id, operator_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(activationId, operator.eventId, operatorId, await sha256(rawToken), expiresAt)
  ]);
  return { activationUrl: `${bindings.APP_ORIGIN}/ativar#token=${rawToken}`, expiresAt };
}

export interface OperationalReport {
  generatedAt: string;
  summary: {
    revenueCents: number;
    paidOrders: number;
    paidUnits: number;
    courtesyUnits: number;
    totalTickets: number;
    availableTickets: number;
    usedTickets: number;
    cancelledTickets: number;
  };
  salesByProduct: Array<{ productId: string; productName: string; paidUnits: number; courtesyUnits: number; revenueCents: number }>;
  detailedSales: Array<{
    orderPublicId: string; createdAt: string; customerName: string; customerCpf: string;
    productName: string; quantity: number; unitPriceCents: number; totalCents: number;
    paymentMethod: string; orderStatus: string;
  }>;
  ticketStatuses: Array<{ ticketCode: string; orderPublicId: string; productName: string; status: string; purchasedAt: string; usedAt: string }>;
  stockSummary: Array<{
    productId: string; productName: string; startingStock: number; adjustments: number;
    paidUnits: number; courtesyUnits: number; withdrawnUnits: number; reservedUnits: number;
    endingPhysicalStock: number; availableForSale: number;
  }>;
}

export async function getOperationalReport(bindings: Bindings, eventId: string): Promise<OperationalReport> {
  const [summaryRow, salesByProduct, detailedSales, ticketStatuses, stockSummary, ticketCounts] = await Promise.all([
    bindings.DB.prepare(`
      SELECT
        (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE event_id = ? AND status = 'PAID' AND kind = 'PAYMENT') AS revenue_cents,
        (SELECT COUNT(*) FROM orders WHERE event_id = ? AND status = 'PAID' AND kind = 'PAYMENT') AS paid_orders,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' AND o.kind = 'PAYMENT' THEN oi.quantity ELSE 0 END), 0) AS paid_units,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' AND o.kind = 'COURTESY' THEN oi.quantity ELSE 0 END), 0) AS courtesy_units
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.event_id = ?
    `).bind(eventId, eventId, eventId).first<Record<string, number>>(),
    bindings.DB.prepare(`
      SELECT p.id AS product_id, p.name AS product_name,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' AND o.kind = 'PAYMENT' THEN oi.quantity ELSE 0 END), 0) AS paid_units,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' AND o.kind = 'COURTESY' THEN oi.quantity ELSE 0 END), 0) AS courtesy_units,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' AND o.kind = 'PAYMENT' THEN oi.total_cents ELSE 0 END), 0) AS revenue_cents
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id AND oi.event_id = p.event_id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'PAID'
      WHERE p.event_id = ?
      GROUP BY p.id, p.name, p.sort_order
      ORDER BY p.sort_order
    `).bind(eventId).all<{ product_id: string; product_name: string; paid_units: number; courtesy_units: number; revenue_cents: number }>(),
    bindings.DB.prepare(`
      SELECT o.public_id AS order_public_id, o.created_at, COALESCE(o.customer_name, '') AS customer_name,
        COALESCE(o.customer_tax_id, '') AS customer_cpf, oi.product_name, oi.quantity,
        oi.unit_price_cents, oi.total_cents,
        CASE WHEN o.kind = 'COURTESY' THEN 'Cortesia' ELSE COALESCE(o.payment_provider, 'Pix') END AS payment_method,
        o.status AS order_status
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.event_id = ?
      ORDER BY o.created_at DESC, oi.product_name
    `).bind(eventId).all<OperationalReport["detailedSales"][number]>(),
    bindings.DB.prepare(`
      SELECT t.public_id AS ticket_code, o.public_id AS order_public_id, t.product_name,
        t.status, t.created_at AS purchased_at, COALESCE(t.used_at, '') AS used_at
      FROM tickets t JOIN orders o ON o.id = t.order_id
      WHERE t.event_id = ?
      ORDER BY t.created_at DESC
    `).bind(eventId).all<OperationalReport["ticketStatuses"][number]>(),
    bindings.DB.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, i.initial_quantity AS starting_stock,
        i.adjustment_quantity AS adjustments, i.sold_quantity AS paid_units,
        i.courtesy_quantity AS courtesy_units, i.redeemed_quantity AS withdrawn_units,
        i.reserved_quantity AS reserved_units,
        i.initial_quantity + i.adjustment_quantity - i.redeemed_quantity AS ending_physical_stock,
        i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity AS available_for_sale
      FROM products p JOIN inventory i ON i.product_id = p.id AND i.event_id = p.event_id
      WHERE p.event_id = ?
      ORDER BY p.sort_order
    `).bind(eventId).all<OperationalReport["stockSummary"][number]>(),
    bindings.DB.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) AS available,
        COALESCE(SUM(CASE WHEN status = 'USED' THEN 1 ELSE 0 END), 0) AS used,
        COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM tickets WHERE event_id = ?
    `).bind(eventId).first<Record<string, number>>()
  ]);
  const ticketSummary = ticketCounts ?? {};
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      revenueCents: summaryRow?.revenue_cents ?? 0,
      paidOrders: summaryRow?.paid_orders ?? 0,
      paidUnits: summaryRow?.paid_units ?? 0,
      courtesyUnits: summaryRow?.courtesy_units ?? 0,
      totalTickets: ticketSummary.total ?? 0,
      availableTickets: ticketSummary.available ?? 0,
      usedTickets: ticketSummary.used ?? 0,
      cancelledTickets: ticketSummary.cancelled ?? 0
    },
    salesByProduct: salesByProduct.results.map(row => ({
      productId: row.product_id, productName: row.product_name, paidUnits: row.paid_units,
      courtesyUnits: row.courtesy_units, revenueCents: row.revenue_cents
    })),
    detailedSales: camelRows(detailedSales.results),
    ticketStatuses: camelRows(ticketStatuses.results),
    stockSummary: camelRows(stockSummary.results)
  };
}

function camelRows<T>(rows: T[]): T[] {
  return rows.map(row => Object.fromEntries(Object.entries(row as Record<string,unknown>)
    .map(([key,value]) => [key.replace(/_([a-z])/g, (_,letter:string)=>letter.toUpperCase()), value])) as T);
}

export function operationalReportCsv(report: OperationalReport, kind: string): string {
  const safeCsv = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    const protectedText = /^[=+@-]/.test(text) ? `'${text}` : text;
    return `"${protectedText.replaceAll('"', '""')}"`;
  };
  if (kind === "general") {
    const reportRows: unknown[][] = [
      ["RELATÓRIO GERAL DE VENDAS - LUNÁTICOS"],
      ["Gerado em", report.generatedAt],
      []
    ];
    const addSection = (title: string, headers: string[], rows: unknown[][]) => {
      reportRows.push([title], headers, ...rows, []);
    };

    addSection("1. RESUMO DE VENDAS", ["Indicador", "Valor"], [
      ["Faturamento pago (R$)", (report.summary.revenueCents / 100).toFixed(2)],
      ["Pedidos pagos", report.summary.paidOrders],
      ["Unidades vendidas", report.summary.paidUnits],
      ["Cortesias concedidas", report.summary.courtesyUnits],
      ["Fichas totais", report.summary.totalTickets],
      ["Fichas disponíveis", report.summary.availableTickets],
      ["Fichas retiradas", report.summary.usedTickets],
      ["Fichas canceladas", report.summary.cancelledTickets]
    ]);
    addSection("Vendas por produto", ["Produto", "Unidades vendidas", "Cortesias concedidas", "Faturamento (R$)"], [
      ...report.salesByProduct.map(product => [product.productName, product.paidUnits, product.courtesyUnits, (product.revenueCents / 100).toFixed(2)]),
      ["TOTAL GERAL", report.summary.paidUnits, report.summary.courtesyUnits, (report.summary.revenueCents / 100).toFixed(2)]
    ]);
    addSection("2. VENDAS DETALHADAS", ["Pedido", "Data/hora", "Cliente", "CPF", "Produto", "Quantidade", "Preço unitário (R$)", "Total do item (R$)", "Pagamento", "Status"],
      report.detailedSales.map(sale => [sale.orderPublicId, sale.createdAt, sale.customerName, sale.customerCpf, sale.productName, sale.quantity, (sale.unitPriceCents / 100).toFixed(2), (sale.totalCents / 100).toFixed(2), sale.paymentMethod, sale.orderStatus]));
    addSection("3. STATUS DAS FICHAS", ["Código da ficha", "Pedido", "Produto", "Status", "Data da compra", "Data de retirada"],
      report.ticketStatuses.map(ticket => [ticket.ticketCode, ticket.orderPublicId, ticket.productName, ticket.status, ticket.purchasedAt, ticket.usedAt]));
    addSection("4. RESUMO DE ESTOQUE", ["Produto", "Estoque inicial", "Ajustes líquidos", "Unidades vendidas", "Cortesias", "Unidades retiradas", "Reservadas", "Estoque físico final esperado", "Disponível para venda"],
      report.stockSummary.map(product => [product.productName, product.startingStock, product.adjustments, product.paidUnits, product.courtesyUnits, product.withdrawnUnits, product.reservedUnits, product.endingPhysicalStock, product.availableForSale]));

    return `\uFEFF${reportRows.map(row => row.map(safeCsv).join(",")).join("\r\n")}`;
  }
  let headers: string[];
  let rows: Array<Record<string, unknown>>;
  if (kind === "summary") {
    headers = ["Produto", "Unidades vendidas", "Cortesias concedidas", "Faturamento (R$)", "Pedidos pagos", "Fichas totais", "Fichas disponíveis", "Fichas retiradas", "Fichas canceladas"];
    rows = report.salesByProduct.map(product => ({
      Produto: product.productName, "Unidades vendidas": product.paidUnits,
      "Cortesias concedidas": product.courtesyUnits, "Faturamento (R$)": (product.revenueCents / 100).toFixed(2)
    }));
    rows.push({
      Produto: "TOTAL GERAL", "Unidades vendidas": report.summary.paidUnits,
      "Cortesias concedidas": report.summary.courtesyUnits, "Faturamento (R$)": (report.summary.revenueCents / 100).toFixed(2),
      "Pedidos pagos": report.summary.paidOrders, "Fichas totais": report.summary.totalTickets,
      "Fichas disponíveis": report.summary.availableTickets, "Fichas retiradas": report.summary.usedTickets,
      "Fichas canceladas": report.summary.cancelledTickets
    });
  } else if (kind === "sales") {
    headers = ["Pedido", "Data/hora", "Cliente", "CPF", "Produto", "Quantidade", "Preço unitário (R$)", "Total do item (R$)", "Pagamento", "Status"];
    rows = report.detailedSales.map(sale => ({
      Pedido: sale.orderPublicId, "Data/hora": sale.createdAt, Cliente: sale.customerName, CPF: sale.customerCpf,
      Produto: sale.productName, Quantidade: sale.quantity, "Preço unitário (R$)": (sale.unitPriceCents / 100).toFixed(2),
      "Total do item (R$)": (sale.totalCents / 100).toFixed(2), Pagamento: sale.paymentMethod, Status: sale.orderStatus
    }));
  } else if (kind === "tickets") {
    headers = ["Código da ficha", "Pedido", "Produto", "Status", "Data da compra", "Data de retirada"];
    rows = report.ticketStatuses.map(ticket => ({
      "Código da ficha": ticket.ticketCode, Pedido: ticket.orderPublicId, Produto: ticket.productName,
      Status: ticket.status, "Data da compra": ticket.purchasedAt, "Data de retirada": ticket.usedAt
    }));
  } else if (kind === "stock") {
    headers = ["Produto", "Estoque inicial", "Ajustes líquidos", "Unidades vendidas", "Cortesias", "Unidades retiradas", "Reservadas", "Estoque físico final esperado", "Disponível para venda"];
    rows = report.stockSummary.map(product => ({
      Produto: product.productName, "Estoque inicial": product.startingStock, "Ajustes líquidos": product.adjustments,
      "Unidades vendidas": product.paidUnits, Cortesias: product.courtesyUnits, "Unidades retiradas": product.withdrawnUnits,
      Reservadas: product.reservedUnits, "Estoque físico final esperado": product.endingPhysicalStock,
      "Disponível para venda": product.availableForSale
    }));
  } else {
    throw new ApiError(404, "REPORT_NOT_FOUND", "Relatório não encontrado.");
  }
  return `\uFEFF${headers.map(safeCsv).join(",")}\r\n${rows.map(row => headers.map(header => safeCsv(row[header])).join(",")).join("\r\n")}`;
}

export async function getHealth(bindings: Bindings, eventId: string): Promise<Record<string, unknown>> {
  const counts = await bindings.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE event_id = ?) AS orders,
      (SELECT COUNT(*) FROM tickets WHERE event_id = ?) AS tickets,
      (SELECT COUNT(*) FROM webhook_events WHERE received_at >= datetime('now', '-1 day')) AS webhooks_24h,
      (SELECT COUNT(*) FROM orders WHERE event_id = ? AND status = 'PENDING_PAYMENT') AS pending,
      (SELECT COUNT(*) FROM orders WHERE event_id = ? AND status = 'PAYMENT_EXCEPTION') AS exceptions
  `).bind(eventId, eventId, eventId, eventId).first<Record<string, number>>();
  const projectedDynamicRequests = (counts?.orders ?? 0) * 30 + (counts?.tickets ?? 0) * 2 + (counts?.webhooks_24h ?? 0);
  return {
    status: (counts?.exceptions ?? 0) > 0 ? "ATTENTION" : "OK",
    now: new Date().toISOString(),
    paymentMode: bindings.PAYMENTS_MODE,
    counts,
    freeTier: {
      workerDailyLimit: 100_000,
      operationalBudget: 70_000,
      projectedDynamicRequests,
      note: "Estimativa por eventos de negócio; confirme o uso real no painel da Cloudflare."
    }
  };
}

