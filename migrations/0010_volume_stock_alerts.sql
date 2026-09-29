ALTER TABLE products ADD COLUMN stock_unit TEXT NOT NULL DEFAULT 'UNIT' CHECK (stock_unit IN ('UNIT', 'L', 'ML'));
ALTER TABLE products ADD COLUMN portion_ml INTEGER NOT NULL DEFAULT 0 CHECK (portion_ml >= 0);
ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold BETWEEN 0 AND 100000);
ALTER TABLE inventory ADD COLUMN initial_volume_ml INTEGER NOT NULL DEFAULT 0 CHECK (initial_volume_ml >= 0);
ALTER TABLE inventory ADD COLUMN adjustment_volume_ml INTEGER NOT NULL DEFAULT 0;

CREATE TABLE stock_states (
  event_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (event_id, product_id)
);
CREATE TABLE stock_alerts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_id TEXT NOT NULL REFERENCES events(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('LOW', 'RESERVED', 'EXHAUSTED')),
  available_quantity INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  committed_quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES operators(id)
);
CREATE INDEX idx_stock_alerts_event ON stock_alerts(event_id, created_at);
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  session_id TEXT NOT NULL REFERENCES operator_sessions(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE stock_alert_deliveries (
  alert_id TEXT NOT NULL REFERENCES stock_alerts(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  last_status INTEGER,
  updated_at TEXT,
  PRIMARY KEY (alert_id, subscription_id)
);

CREATE VIEW stock_current_states AS
SELECT i.event_id, i.product_id,
  i.initial_quantity + i.adjustment_quantity AS capacity,
  i.sold_quantity + i.courtesy_quantity AS committed_quantity,
  i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity AS available_quantity,
  CASE
    WHEN i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity = 0
      THEN CASE WHEN i.reserved_quantity > 0 THEN 'RESERVED' ELSE 'EXHAUSTED' END
    WHEN i.initial_quantity + i.adjustment_quantity - i.reserved_quantity - i.sold_quantity - i.courtesy_quantity <= p.low_stock_threshold THEN 'LOW'
    ELSE 'OK'
  END AS state
FROM inventory i JOIN products p ON p.id = i.product_id AND p.event_id = i.event_id;

-- Track existing balances without manufacturing alerts for untouched seed data.
INSERT INTO stock_states SELECT event_id, product_id, state FROM stock_current_states;

CREATE TRIGGER stock_inventory_updated AFTER UPDATE OF initial_quantity, adjustment_quantity, reserved_quantity, sold_quantity, courtesy_quantity ON inventory
BEGIN
  UPDATE stock_alerts SET resolved_at = CURRENT_TIMESTAMP
    WHERE event_id = NEW.event_id AND product_id = NEW.product_id AND resolved_at IS NULL
      AND kind <> (SELECT state FROM stock_current_states WHERE event_id = NEW.event_id AND product_id = NEW.product_id);
  INSERT INTO stock_alerts (event_id, product_id, kind, available_quantity, capacity, committed_quantity)
    SELECT s.event_id, s.product_id, s.state, s.available_quantity, s.capacity, s.committed_quantity
    FROM stock_current_states s LEFT JOIN stock_states old ON old.event_id = s.event_id AND old.product_id = s.product_id
    WHERE s.event_id = NEW.event_id AND s.product_id = NEW.product_id AND s.state <> 'OK'
      AND (old.state IS NULL OR old.state <> s.state);
  INSERT OR REPLACE INTO stock_states SELECT event_id, product_id, state FROM stock_current_states
    WHERE event_id = NEW.event_id AND product_id = NEW.product_id;
END;

CREATE TRIGGER stock_inventory_inserted AFTER INSERT ON inventory
BEGIN
  INSERT OR REPLACE INTO stock_states SELECT event_id, product_id, state FROM stock_current_states
    WHERE event_id = NEW.event_id AND product_id = NEW.product_id;
END;

CREATE TRIGGER stock_settings_updated AFTER UPDATE OF low_stock_threshold ON products
BEGIN
  UPDATE inventory SET initial_quantity = initial_quantity WHERE product_id = NEW.id AND event_id = NEW.event_id;
END;
