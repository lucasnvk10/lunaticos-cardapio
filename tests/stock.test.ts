import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import { adjustVolumeStock, calculateStock, configureStock } from '../worker/services/stock';
import { acknowledgeAlert, dispatchStockPush, recordPushReceipt, validateSubscription } from '../worker/services/alerts';
import { createPaymentOrder } from '../worker/services/orders';
import type { AuthenticatedOperator, Bindings } from '../worker/types';

// Real SQLite constraints/triggers and transactions behind the D1 service interface.
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['migrations/0001_initial.sql', 'migrations/0002_admin_credentials.sql', 'db/seed.sql', 'migrations/0009_ticket_issuance_claims.sql', 'migrations/0010_volume_stock_alerts.sql', 'migrations/0011_refresh_stock_alert_balances.sql', 'migrations/0012_push_delivery_receipts.sql']) db.exec(readFileSync(file, 'utf8'));
  db.exec(`INSERT INTO operators (id,event_id,display_name,role) VALUES ('test_admin','evt_piloto','Teste','ADMIN');
    INSERT INTO operator_sessions (id,event_id,operator_id,token_hash,device_label,expires_at)
    VALUES ('test_session','evt_piloto','test_admin','hash_test','Teste',datetime('now','+1 day'));`);
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const execute = () => {
      const stmt = db.prepare(sql);
      const results = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return { results, success: true, meta: { changes: Number(db.prepare('SELECT changes() AS n').get()!.n) } };
    };
    return { bind(...values: Array<string | number | null>) { args = values; return this; },
      _execute: execute, async first() { return execute().results[0] ?? null; }, async all() { return execute(); }, async run() { return execute(); } };
  };
  const d1 = { prepare, async batch(statements: Array<ReturnType<typeof prepare>>) {
    db.exec('BEGIN'); try { const result = []; for (const stmt of statements) result.push(stmt._execute()); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } } as unknown as D1Database;
  const env = { DB: d1, APP_ORIGIN: 'http://localhost:8787', EVENT_SLUG: 'evento-piloto', PAYMENTS_MODE: 'mock', TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } as Bindings;
  const operator = { id: 'test_admin', eventId: 'evt_piloto', sessionId: 'test_session', role: 'ADMIN' } as AuthenticatedOperator;
  return { db, env, operator };
}

describe('estoque por volume e alertas', () => {
  it('converte litros e ml em copos completos, sem arredondar para cima', () => {
    expect(calculateStock({ stockUnit: 'L', stockAmount: 60, portionMl: 500 }).capacity).toBe(120);
    expect(calculateStock({ stockUnit: 'ML', stockAmount: 60000, portionMl: 440 }).capacity).toBe(136);
    expect(() => calculateStock({ stockUnit: 'L', stockAmount: 60, portionMl: 0 })).toThrow();
    expect(() => calculateStock({ stockUnit: 'UNIT', stockAmount: 1.5 })).toThrow();
    expect(() => calculateStock({ stockUnit: 'L', stockAmount: 0.0001, portionMl: 500 })).toThrow();
  });
  it('configura bebida existente e preserva sobras ao repor volumes menores que um copo', async () => {
    const { db, env, operator } = setup();
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'L', stockAmount: 60, portionMl: 440 });
    await adjustVolumeStock(env, operator, 'prd_cerveja', 0.2, 'Reposição');
    expect(db.prepare("SELECT initial_quantity + adjustment_quantity AS n FROM inventory WHERE product_id='prd_cerveja'").get()!.n).toBe(136);
    await adjustVolumeStock(env, operator, 'prd_cerveja', 0.08, 'Reposição');
    expect(db.prepare("SELECT initial_quantity + adjustment_quantity AS n FROM inventory WHERE product_id='prd_cerveja'").get()!.n).toBe(137);
    await adjustVolumeStock(env, operator, 'prd_cerveja', -0.28, 'Perda');
    expect(db.prepare("SELECT initial_quantity + adjustment_quantity AS n FROM inventory WHERE product_id='prd_cerveja'").get()!.n).toBe(136);
  });
  it('bloqueia reconfiguração e perdas que comprometeriam fichas emitidas', async () => {
    const { db, env, operator } = setup();
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'L', stockAmount: 1, portionMl: 500 });
    db.exec("UPDATE inventory SET sold_quantity=2 WHERE product_id='prd_cerveja'");
    await expect(configureStock(env, operator, 'prd_cerveja', { stockUnit: 'L', stockAmount: 2, portionMl: 440 })).rejects.toMatchObject({ code: 'STOCK_IN_USE' });
    await expect(adjustVolumeStock(env, operator, 'prd_cerveja', -0.5, 'Perda')).rejects.toMatchObject({ code: 'INVALID_STOCK_RESULT' });
    expect(db.prepare("SELECT initial_volume_ml FROM inventory WHERE product_id='prd_cerveja'").get()!.initial_volume_ml).toBe(1000);
  });
  it('registra transições sem duplicar e distingue reserva de esgotamento definitivo', async () => {
    const { db, env, operator } = setup();
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'L', stockAmount: 60, portionMl: 500, lowStockThreshold: 10 });
    db.exec("UPDATE inventory SET sold_quantity=110 WHERE product_id='prd_cerveja'; UPDATE inventory SET sold_quantity=111 WHERE product_id='prd_cerveja';");
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_alerts WHERE product_id='prd_cerveja' AND kind='LOW'").get()!.n).toBe(1);
    expect(db.prepare("SELECT available_quantity FROM stock_alerts WHERE product_id='prd_cerveja' AND kind='LOW' AND resolved_at IS NULL").get()!.available_quantity).toBe(9);
    db.exec("UPDATE inventory SET reserved_quantity=9 WHERE product_id='prd_cerveja'");
    expect(db.prepare("SELECT state FROM stock_states WHERE product_id='prd_cerveja'").get()!.state).toBe('RESERVED');
    // Payment transfers reservation into sold; no double debit.
    db.exec("UPDATE inventory SET reserved_quantity=0,sold_quantity=120 WHERE product_id='prd_cerveja'");
    const alert = db.prepare("SELECT id FROM stock_alerts WHERE product_id='prd_cerveja' AND kind='EXHAUSTED' AND resolved_at IS NULL").get()!;
    await acknowledgeAlert(env, operator, String(alert.id));
    expect(db.prepare("SELECT available_quantity FROM stock_current_states WHERE product_id='prd_cerveja'").get()!.available_quantity).toBe(0);
    // Redemption reduces physical stock only.
    db.exec("UPDATE inventory SET redeemed_quantity=80 WHERE product_id='prd_cerveja'");
    expect(db.prepare("SELECT available_quantity FROM stock_current_states WHERE product_id='prd_cerveja'").get()!.available_quantity).toBe(0);
    await adjustVolumeStock(env, operator, 'prd_cerveja', 1, 'Novo barril');
    expect(db.prepare("SELECT resolved_at FROM stock_alerts WHERE id=?").get(String(alert.id))!.resolved_at).toBeTruthy();
    db.exec("UPDATE inventory SET courtesy_quantity=2 WHERE product_id='prd_cerveja'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_alerts WHERE kind='EXHAUSTED' AND product_id='prd_cerveja'").get()!.n).toBe(2);
  });
  it('libera saldo ao expirar reserva e mantém suspensão manual', async () => {
    const { db, env, operator } = setup();
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'UNIT', stockAmount: 1 });
    db.exec("UPDATE products SET active=0 WHERE id='prd_cerveja'; UPDATE inventory SET reserved_quantity=1 WHERE product_id='prd_cerveja'; UPDATE inventory SET reserved_quantity=0 WHERE product_id='prd_cerveja';");
    expect(db.prepare("SELECT available_quantity FROM stock_current_states WHERE product_id='prd_cerveja'").get()!.available_quantity).toBe(1);
    expect(db.prepare("SELECT active FROM products WHERE id='prd_cerveja'").get()!.active).toBe(0);
  });
  it('uma segunda reserva não pode consumir o último copo já reservado', async () => {
    const { db, env, operator } = setup();
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'L', stockAmount: 0.5, portionMl: 500 });
    const input = { eventSlug: 'evento-piloto', idempotencyKey: 'request_first_stock_test', accessToken: 'x'.repeat(43), customer: { name: 'Teste estoque', taxId: '52998224725' }, items: [{ productId: 'prd_cerveja', quantity: 1 }] };
    const results = await Promise.allSettled([createPaymentOrder(env, input), createPaymentOrder(env, { ...input, idempotencyKey: 'request_second_stock_test' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'OUT_OF_STOCK' } });
    expect(db.prepare("SELECT reserved_quantity FROM inventory WHERE product_id='prd_cerveja'").get()!.reserved_quantity).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n).toBe(1);
  });
  it('recusa endpoints de push arbitrários e informa falha sem chaves', async () => {
    expect(() => validateSubscription({ endpoint: 'https://localhost/private', keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) } })).toThrow();
    const { env } = setup();
    const request = vi.spyOn(globalThis, 'fetch'); await dispatchStockPush(env); expect(request).not.toHaveBeenCalled(); request.mockRestore();
  });
  it('criptografa o push, registra aceite e para novas tentativas após ciência', async () => {
    const { db, env, operator } = setup();
    const vapid = webPush.generateVAPIDKeys();
    env.VAPID_PUBLIC_KEY = vapid.publicKey; env.VAPID_PRIVATE_KEY = vapid.privateKey; env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    const receiver = webPush.generateVAPIDKeys();
    db.prepare(`INSERT INTO push_subscriptions (id,event_id,operator_id,session_id,endpoint,p256dh,auth)
      VALUES ('push_test','evt_piloto','test_admin','test_session','https://fcm.googleapis.com/fcm/send/test',?,?)`).run(receiver.publicKey, Buffer.alloc(16, 1).toString('base64url'));
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'UNIT', stockAmount: 1 });
    db.exec("UPDATE inventory SET sold_quantity=1 WHERE product_id='prd_cerveja'");
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    try {
      await dispatchStockPush(env);
      expect(request).toHaveBeenCalledOnce();
      const options = request.mock.calls[0][1]!;
      expect(options.body).toBeInstanceOf(Uint8Array);
      expect(options.redirect).toBe('manual');
      expect((options.headers as Record<string, string>)['Content-Encoding']).toBe('aes128gcm');
      expect(db.prepare('SELECT status FROM stock_alert_deliveries').get()!.status).toBe('ACCEPTED');
      const alertId = String(db.prepare("SELECT id FROM stock_alerts WHERE kind='EXHAUSTED' AND resolved_at IS NULL").get()!.id);
      await recordPushReceipt(env, { ...operator, sessionId: 'other_session' }, alertId);
      expect(db.prepare('SELECT received_at FROM stock_alert_deliveries').get()!.received_at).toBeNull();
      await recordPushReceipt(env, operator, alertId);
      expect(db.prepare('SELECT received_at FROM stock_alert_deliveries').get()!.received_at).toBeTruthy();
      expect(db.prepare('SELECT acknowledged_at FROM stock_alerts WHERE id=?').get(alertId)!.acknowledged_at).toBeNull();
      await acknowledgeAlert(env, operator, alertId);
      db.exec("UPDATE stock_alert_deliveries SET updated_at=datetime('now','-3 minutes')");
      await dispatchStockPush(env); expect(request).toHaveBeenCalledOnce();
    } finally { request.mockRestore(); }
  });
  it('descarta inscrição expirada no serviço push e impede envio em sessão revogada', async () => {
    const { db, env, operator } = setup(); const vapid = webPush.generateVAPIDKeys();
    env.VAPID_PUBLIC_KEY = vapid.publicKey; env.VAPID_PRIVATE_KEY = vapid.privateKey; env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    db.prepare(`INSERT INTO push_subscriptions (id,event_id,operator_id,session_id,endpoint,p256dh,auth)
      VALUES ('push_test','evt_piloto','test_admin','test_session','https://fcm.googleapis.com/fcm/send/test',?,?)`).run(webPush.generateVAPIDKeys().publicKey, Buffer.alloc(16, 1).toString('base64url'));
    await configureStock(env, operator, 'prd_cerveja', { stockUnit: 'UNIT', stockAmount: 1 }); db.exec("UPDATE inventory SET sold_quantity=1 WHERE product_id='prd_cerveja'");
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 410 }));
    try {
      await dispatchStockPush(env); expect(db.prepare('SELECT enabled FROM push_subscriptions').get()!.enabled).toBe(0);
      db.exec("UPDATE push_subscriptions SET enabled=1; UPDATE stock_alert_deliveries SET updated_at=datetime('now','-3 minutes'); UPDATE operator_sessions SET revoked_at=CURRENT_TIMESTAMP;");
      await dispatchStockPush(env); expect(request).toHaveBeenCalledOnce();
    } finally { request.mockRestore(); }
  });
});
