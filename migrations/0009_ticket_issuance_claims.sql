-- One durable claim per paid order prevents duplicate ticket issuance when
-- the PagBank webhook and the customer's status refresh arrive together.
CREATE TABLE ticket_issuance_claims (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ticket_issuance_claims (order_id, event_id)
SELECT id, event_id FROM orders WHERE status = 'PAID';
