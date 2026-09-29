DROP TRIGGER stock_inventory_updated;
CREATE TRIGGER stock_inventory_updated AFTER UPDATE OF initial_quantity, adjustment_quantity, reserved_quantity, sold_quantity, courtesy_quantity ON inventory
BEGIN
  UPDATE stock_alerts SET
    available_quantity = (SELECT available_quantity FROM stock_current_states WHERE event_id = NEW.event_id AND product_id = NEW.product_id),
    capacity = NEW.initial_quantity + NEW.adjustment_quantity,
    committed_quantity = NEW.sold_quantity + NEW.courtesy_quantity
    WHERE event_id = NEW.event_id AND product_id = NEW.product_id AND resolved_at IS NULL
      AND kind = (SELECT state FROM stock_current_states WHERE event_id = NEW.event_id AND product_id = NEW.product_id);
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
