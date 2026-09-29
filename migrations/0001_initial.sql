PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  catalog_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🥤',
  color TEXT NOT NULL DEFAULT '#7c3aed',
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, slug)
);

CREATE TABLE inventory (
  event_id TEXT NOT NULL REFERENCES events(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  initial_quantity INTEGER NOT NULL DEFAULT 0,
  adjustment_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
  courtesy_quantity INTEGER NOT NULL DEFAULT 0 CHECK (courtesy_quantity >= 0),
  redeemed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_quantity >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id, product_id),
  CHECK (initial_quantity + adjustment_quantity - reserved_quantity - sold_quantity - courtesy_quantity >= 0),
  CHECK (redeemed_quantity <= sold_quantity + courtesy_quantity)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('PAYMENT', 'COURTESY')),
  status TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'EXPIRED', 'PAYMENT_EXCEPTION', 'CANCELLED')),
  idempotency_key TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  customer_name TEXT,
  customer_email TEXT,
  customer_tax_id TEXT,
  customer_phone TEXT,
  payment_provider TEXT,
  provider_order_id TEXT,
  provider_charge_id TEXT,
  pix_code TEXT,
  pix_image_url TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, idempotency_key)
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL,
  UNIQUE(order_id, product_id)
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, external_id)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'USED', 'CANCELLED')),
  used_at TEXT,
  used_by_operator_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ticket_redemptions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  operator_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE courtesy_campaigns (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED')),
  total_limit INTEGER NOT NULL CHECK (total_limit > 0),
  used_quantity INTEGER NOT NULL DEFAULT 0 CHECK (used_quantity >= 0 AND used_quantity <= total_limit),
  quantity_per_use INTEGER NOT NULL DEFAULT 1 CHECK (quantity_per_use > 0),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by_operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE courtesy_campaign_products (
  campaign_id TEXT NOT NULL REFERENCES courtesy_campaigns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  PRIMARY KEY(campaign_id, product_id)
);

CREATE TABLE courtesy_redemptions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  campaign_id TEXT NOT NULL REFERENCES courtesy_campaigns(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MARKETING', 'BARTENDER')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activation_tokens (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operator_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reference_id TEXT,
  reason TEXT,
  operator_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  UNIQUE(provider, event_key)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_catalog ON products(event_id, active, sort_order);
CREATE INDEX idx_orders_status ON orders(event_id, status, created_at);
CREATE INDEX idx_orders_provider ON orders(provider_order_id, provider_charge_id);
CREATE INDEX idx_reservations_expiry ON reservations(status, expires_at);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_tickets_order ON tickets(order_id, status);
CREATE INDEX idx_tickets_token ON tickets(token_hash);
CREATE INDEX idx_sessions_token ON operator_sessions(token_hash, revoked_at, expires_at);
CREATE INDEX idx_campaign_status ON courtesy_campaigns(event_id, status, starts_at, expires_at);
CREATE INDEX idx_movements_product ON inventory_movements(event_id, product_id, created_at);

CREATE TRIGGER ticket_redeemed_inventory
AFTER UPDATE OF status ON tickets
WHEN OLD.status = 'AVAILABLE' AND NEW.status = 'USED'
BEGIN
  UPDATE inventory
  SET redeemed_quantity = redeemed_quantity + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE event_id = NEW.event_id AND product_id = NEW.product_id;
END;
