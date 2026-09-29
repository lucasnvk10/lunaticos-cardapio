import type { Bindings, AuthenticatedOperator } from '../types';
import { ApiError, createId, createRandomToken, sha256, isoAfterMinutes } from '../utils';

export async function scannerLink(env: Bindings, operator: AuthenticatedOperator) {
  const token = createRandomToken();
  const expiresAt = isoAfterMinutes(1440);
  await env.DB.prepare('INSERT INTO scanner_invites (id,event_id,token_hash,created_by,expires_at) VALUES (?,?,?,?,?)')
    .bind(createId('inv'), operator.eventId, await sha256(token), operator.id, expiresAt).run();
  return { activationUrl: `${env.APP_ORIGIN}/ativar#token=${token}&reader=1`, expiresAt };
}

export async function joinScanner(env: Bindings, token: string, name: string) {
  name = name.trim();
  if (name.length < 2 || name.length > 100) throw new ApiError(400, 'INVALID_NAME', 'Informe seu nome, entre 2 e 100 caracteres.');
  const id = createId('opr');
  const hash = await sha256(token);
  // D1 batch is transactional. changes() refers to the immediately preceding update.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE scanner_invites SET uses=uses+1 WHERE token_hash=? AND revoked_at IS NULL
      AND datetime(expires_at)>CURRENT_TIMESTAMP AND uses<max_uses RETURNING id,event_id`).bind(hash),
    env.DB.prepare(`INSERT INTO operators (id,event_id,display_name,role,scanner_invite_id)
      SELECT ?,event_id,?,'EVENTOS',id FROM scanner_invites WHERE token_hash=? AND changes()=1`).bind(id,name,hash)
  ]);
  const invite = result[0].results[0] as { event_id: string } | undefined;
  if (!invite) throw new ApiError(404, 'INVITE_INVALID', 'Link expirado, revogado ou com limite de leitores atingido.');
  return { id, eventId: invite.event_id };
}

export async function team(env: Bindings, eventId: string) {
  return (await env.DB.prepare(`SELECT o.id,o.display_name AS name,o.role,o.active,o.created_at AS registeredAt,
    (SELECT COUNT(*) FROM operator_sessions s WHERE s.operator_id=o.id AND s.revoked_at IS NULL AND datetime(s.expires_at)>CURRENT_TIMESTAMP) AS devices,
    (SELECT COUNT(*) FROM tickets t WHERE t.used_by_operator_id=o.id) AS readings
    FROM operators o WHERE o.event_id=? ORDER BY o.role='ADMIN' DESC,o.created_at DESC`).bind(eventId).all()).results;
}

export function searchPattern(query: string) {
  return `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

export async function listOrders(env: Bindings, eventId: string, query: string, page: number, payments = false) {
  query = query.trim().slice(0,120);
  const pattern = searchPattern(query);
  const digits = query.replace(/\D/g,'');
  const where = `o.event_id=? AND (?=0 OR o.kind='PAYMENT') AND (?='' OR o.customer_name LIKE ? ESCAPE '\\' COLLATE NOCASE
    OR o.public_id LIKE ? ESCAPE '\\' COLLATE NOCASE OR (?<>'' AND o.customer_phone=?))`;
  const args = [eventId,payments?1:0,query,pattern,pattern,digits,digits];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`).bind(...args).first<{total:number}>();
  const rows = (await env.DB.prepare(`SELECT o.id,o.public_id AS number,o.customer_name AS name,o.customer_phone AS phone,
    o.status,o.kind,o.amount_cents AS amount,o.created_at AS createdAt,o.paid_at AS paidAt,o.payment_provider AS provider,
    o.provider_charge_id AS chargeId FROM orders o WHERE ${where} ORDER BY o.created_at DESC,o.id LIMIT 25 OFFSET ?`)
    .bind(...args,(page-1)*25).all<Record<string,unknown>>()).results;
  const orders = await Promise.all(rows.map(async row => {
    const items = (await env.DB.prepare(`SELECT oi.product_name AS name,oi.quantity,
      (SELECT COUNT(*) FROM tickets t WHERE t.order_id=oi.order_id AND t.product_id=oi.product_id AND t.status='USED') AS used,
      (SELECT COUNT(*) FROM tickets t WHERE t.order_id=oi.order_id AND t.product_id=oi.product_id AND t.status='AVAILABLE') AS available
      FROM order_items oi WHERE oi.order_id=? AND oi.event_id=?`).bind(row.id,eventId).all()).results;
    const {id: _id,...safe} = row;
    return {...safe, items};
  }));
  const received = payments ? await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN upper(COALESCE(payment_provider,''))='PAGBANK' THEN amount_cents ELSE 0 END),0) AS real,
    COALESCE(SUM(CASE WHEN upper(COALESCE(payment_provider,''))<>'PAGBANK' THEN amount_cents ELSE 0 END),0) AS test
    FROM orders WHERE event_id=? AND kind='PAYMENT' AND status='PAID'`).bind(eventId).first() : null;
  return {orders,total:total?.total??0,page,received};
}

export function pareto(products: Array<{productName:string;revenueCents:number;paidUnits:number}>) {
  const sorted = products.filter(p=>p.revenueCents>0).sort((a,b)=>b.revenueCents-a.revenueCents);
  const total = sorted.reduce((sum,p)=>sum+p.revenueCents,0);
  let cumulative = 0;
  return sorted.map(p=>{ const previous=cumulative; cumulative+=p.revenueCents;
    return {...p,share: p.revenueCents/total*100,cumulative:cumulative/total*100,priority:previous/total<0.8}; });
}
