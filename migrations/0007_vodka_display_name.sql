UPDATE products SET name = 'Vodka com energético', updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug = 'vodka-energetico';
UPDATE events SET catalog_version = catalog_version + 1 WHERE id = 'evt_piloto';
