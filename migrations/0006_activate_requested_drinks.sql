UPDATE products SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE event_id = 'evt_piloto' AND slug IN ('chopp', 'chevette', 'jurupinga', 'vodka-energetico', 'gummy');
UPDATE events SET catalog_version = catalog_version + 1 WHERE id = 'evt_piloto';
