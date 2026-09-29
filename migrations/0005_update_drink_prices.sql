UPDATE products SET unit_price_cents = 900, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'chopp';
UPDATE products SET unit_price_cents = 500, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'chevette';
UPDATE products SET unit_price_cents = 500, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'gummy';
UPDATE products SET unit_price_cents = 600, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'vodka-energetico';
UPDATE products SET unit_price_cents = 1000, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'jurupinga';
UPDATE events SET catalog_version = catalog_version + 1 WHERE id = 'evt_piloto';
