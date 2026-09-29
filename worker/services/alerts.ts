import webPush from 'web-push';
import type { AuthenticatedOperator, Bindings } from '../types';
import { ApiError, createId } from '../utils';

export function pushConfigured(env: Bindings) { return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT); }
export function validateSubscription(raw: unknown): webPush.PushSubscription {
  const value = raw as Partial<webPush.PushSubscription> | null;
  let url: URL;
  try { url = new URL(String(value?.endpoint)); } catch { throw new ApiError(400, 'INVALID_PUSH', 'Endereço de notificação inválido.'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port ||
      !value?.keys || !/^[A-Za-z0-9_-]{87}$/.test(value.keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(value.keys.auth) || String(value.endpoint).length > 2048)
    throw new ApiError(400, 'INVALID_PUSH', 'A assinatura de notificação não é válida ou o serviço não é suportado.');
  return value as webPush.PushSubscription;
}

export async function subscribePush(env: Bindings, operator: AuthenticatedOperator, raw: unknown) {
  if (!pushConfigured(env)) throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'Notificações externas ainda não foram configuradas. Os avisos continuam disponíveis na gestão.');
  const sub = validateSubscription(raw);
  await env.DB.prepare(`INSERT INTO push_subscriptions (id, event_id, operator_id, session_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET
    event_id = excluded.event_id, operator_id = excluded.operator_id, session_id = excluded.session_id,
    p256dh = excluded.p256dh, auth = excluded.auth, enabled = 1`)
    .bind(createId('push'), operator.eventId, operator.id, operator.sessionId, sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();
}

export async function getAlerts(env: Bindings, operator: AuthenticatedOperator) {
  const alerts = await env.DB.prepare(`SELECT a.*, p.name AS product_name, o.display_name AS acknowledged_name,
    (SELECT COUNT(*) FROM stock_alert_deliveries d WHERE d.alert_id = a.id AND d.status = 'ACCEPTED') AS push_accepted,
    (SELECT COUNT(*) FROM stock_alert_deliveries d WHERE d.alert_id = a.id AND d.received_at IS NOT NULL) AS push_received,
    (SELECT COUNT(*) FROM stock_alert_deliveries d WHERE d.alert_id = a.id AND d.status = 'FAILED') AS push_failed
    FROM stock_alerts a JOIN products p ON p.id = a.product_id
    LEFT JOIN operators o ON o.id = a.acknowledged_by
    WHERE a.event_id = ? ORDER BY (a.resolved_at IS NULL AND a.acknowledged_at IS NULL) DESC, a.created_at DESC, a.rowid DESC LIMIT 30`)
    .bind(operator.eventId).all();
  const subscription = await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE event_id = ? AND session_id = ? AND enabled = 1')
    .bind(operator.eventId, operator.sessionId).first<{ count: number }>();
  return { alerts: alerts.results, pushConfigured: pushConfigured(env), publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null, subscribed: Boolean(subscription?.count) };
}

export async function acknowledgeAlert(env: Bindings, operator: AuthenticatedOperator, alertId: string) {
  const row = await env.DB.prepare(`UPDATE stock_alerts SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ?
    WHERE id = ? AND event_id = ? AND acknowledged_at IS NULL RETURNING id`).bind(operator.id, alertId, operator.eventId).first();
  if (!row) {
    const exists = await env.DB.prepare('SELECT id FROM stock_alerts WHERE id = ? AND event_id = ?').bind(alertId, operator.eventId).first();
    if (!exists) throw new ApiError(404, 'ALERT_NOT_FOUND', 'Aviso não encontrado.');
  }
}

export async function recordPushReceipt(env: Bindings, operator: AuthenticatedOperator, alertId: string) {
  await env.DB.prepare(`UPDATE stock_alert_deliveries SET received_at = COALESCE(received_at, CURRENT_TIMESTAMP)
    WHERE alert_id = ? AND subscription_id IN
    (SELECT id FROM push_subscriptions WHERE event_id = ? AND session_id = ? AND operator_id = ?)`)
    .bind(alertId, operator.eventId, operator.sessionId, operator.id).run();
}

export async function dispatchStockPush(env: Bindings) {
  if (!pushConfigured(env)) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO stock_alert_deliveries (alert_id, subscription_id)
    SELECT a.id, s.id FROM stock_alerts a JOIN push_subscriptions s ON s.event_id = a.event_id
    JOIN operator_sessions os ON os.id = s.session_id JOIN operators o ON o.id = s.operator_id
    WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL AND s.enabled = 1
    AND os.revoked_at IS NULL AND os.expires_at > CURRENT_TIMESTAMP AND o.active = 1 AND o.role = 'ADMIN'`).run();
  const rows = await env.DB.prepare(`SELECT d.alert_id, d.subscription_id, a.kind, a.available_quantity,
    a.capacity, a.committed_quantity, p.name, s.endpoint, s.p256dh, s.auth
    FROM stock_alert_deliveries d JOIN stock_alerts a ON a.id = d.alert_id
    JOIN products p ON p.id = a.product_id JOIN push_subscriptions s ON s.id = d.subscription_id
    JOIN operator_sessions os ON os.id = s.session_id JOIN operators o ON o.id = s.operator_id
    WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL AND s.enabled = 1
      AND os.revoked_at IS NULL AND os.expires_at > CURRENT_TIMESTAMP AND o.active = 1 AND o.role = 'ADMIN'
      AND d.attempts < 3 AND (d.updated_at IS NULL OR d.updated_at < datetime('now', '-2 minutes')) LIMIT 20`)
    .all<{ alert_id: string; subscription_id: string; kind: string; available_quantity: number; capacity: number; committed_quantity: number; name: string; endpoint: string; p256dh: string; auth: string }>();
  for (const row of rows.results) {
    const claim = await env.DB.prepare(`UPDATE stock_alert_deliveries SET status = 'SENDING', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE alert_id = ? AND subscription_id = ? AND attempts < 3
      AND (updated_at IS NULL OR updated_at < datetime('now', '-2 minutes')) RETURNING alert_id`)
      .bind(row.alert_id, row.subscription_id).first();
    if (!claim) continue;
    let status = 0;
    let stage = 'encryption';
    try {
      const subscription = validateSubscription({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
      const body = row.kind === 'LOW' ? `Restam ${row.available_quantity} fichas para venda.` : row.kind === 'RESERVED'
        ? 'Todo o saldo está comprometido por fichas e reservas de Pix. Novas vendas bloqueadas.'
        : `${row.committed_quantity} de ${row.capacity} porções comprometidas. Venda bloqueada automaticamente.`;
      const request = webPush.generateRequestDetails(subscription, JSON.stringify({ title: `${row.name}: ${row.kind === 'LOW' ? 'está acabando' : row.kind === 'RESERVED' ? 'saldo reservado' : 'esgotado'}`, body, tag: row.alert_id, url: '/equipe' }), {
        vapidDetails: { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
        TTL: 120, urgency: 'high'
      });
      stage = 'network';
      const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers as Record<string, string>,
        body: new Uint8Array(request.body!), redirect: 'manual', signal: AbortSignal.timeout(10000) });
      status = response.status;
      if (status === 404 || status === 410) await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0 WHERE id = ?').bind(row.subscription_id).run();
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/[A-Za-z0-9_-]{16,}/g, '[value]').slice(0, 180) : 'UnknownError';
      console.error('Stock push failed', stage, detail);
    }
    await env.DB.prepare(`UPDATE stock_alert_deliveries SET status = ?, last_status = ?, updated_at = CURRENT_TIMESTAMP WHERE alert_id = ? AND subscription_id = ?`)
      .bind(status >= 200 && status < 300 ? 'ACCEPTED' : 'FAILED', status, row.alert_id, row.subscription_id).run();
  }
}
