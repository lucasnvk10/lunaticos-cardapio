import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(join(process.cwd(), "migrations", "0001_initial.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0002_admin_credentials.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "db", "seed.sql"), "utf8"));
  return database;
}

describe("invariantes do banco", () => {
  it("impede reservar mais unidades que o estoque", () => {
    const database = createDatabase();
    expect(() => database.exec("UPDATE inventory SET reserved_quantity = 2001 WHERE product_id = 'prd_cerveja'")).toThrow(/CHECK constraint failed/i);
  });

  it("reverte todo o lote quando um produto não possui estoque", () => {
    const database = createDatabase();
    expect(() => database.exec(`
      BEGIN;
      UPDATE inventory SET reserved_quantity = reserved_quantity + 10 WHERE product_id = 'prd_cerveja';
      UPDATE inventory SET reserved_quantity = reserved_quantity + 1001 WHERE product_id = 'prd_chevette';
      COMMIT;
    `)).toThrow();
    database.exec("ROLLBACK");
    const row = database.prepare("SELECT reserved_quantity FROM inventory WHERE product_id = 'prd_cerveja'").get() as { reserved_quantity: number };
    expect(row.reserved_quantity).toBe(0);
  });

  it("contabiliza somente a primeira retirada da ficha", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO orders (id, public_id, event_id, kind, status, idempotency_key, access_token_hash, amount_cents)
      VALUES ('ord_test', 'pedido_test', 'evt_piloto', 'PAYMENT', 'PAID', 'idem_test', 'hash', 800);
      INSERT INTO order_items (id, event_id, order_id, product_id, product_name, unit_price_cents, quantity, total_cents)
      VALUES ('itm_test', 'evt_piloto', 'ord_test', 'prd_cerveja', 'Cerveja', 800, 1, 800);
      UPDATE inventory SET sold_quantity = 1 WHERE product_id = 'prd_cerveja';
      INSERT INTO tickets (id, public_id, event_id, order_id, order_item_id, product_id, product_name, token_hash, token_ciphertext, token_iv)
      VALUES ('tkt_test', 'ficha_test', 'evt_piloto', 'ord_test', 'itm_test', 'prd_cerveja', 'Cerveja', 'token_hash', 'cipher', 'iv');
      UPDATE tickets SET status = 'USED' WHERE id = 'tkt_test' AND status = 'AVAILABLE';
      UPDATE tickets SET status = 'USED' WHERE id = 'tkt_test' AND status = 'AVAILABLE';
    `);
    const inventory = database.prepare("SELECT redeemed_quantity FROM inventory WHERE product_id = 'prd_cerveja'").get() as { redeemed_quantity: number };
    expect(inventory.redeemed_quantity).toBe(1);
  });
});
