UPDATE products SET slug = 'chopp', name = 'Chopp', description = 'Chopp gelado', emoji = '🍺', color = '#ff5b00', sort_order = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 'prd_cerveja';
UPDATE products SET name = 'Chevette', description = 'Chevette', color = '#ff5b00', sort_order = 2, updated_at = CURRENT_TIMESTAMP WHERE id = 'prd_chevette';
UPDATE products SET name = 'Gummy', description = 'Gummy', color = '#ff5b00', sort_order = 5, updated_at = CURRENT_TIMESTAMP WHERE id = 'prd_gummy';
UPDATE products SET name = 'Água (produto antigo)', active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 'prd_agua';
INSERT OR IGNORE INTO products (id, event_id, slug, name, description, emoji, color, unit_price_cents, sort_order, active)
VALUES
  ('prd_jurupinga', 'evt_piloto', 'jurupinga', 'Jurupinga', 'Jurupinga', '🍷', '#ff5b00', 0, 3, 0),
  ('prd_vodka_energetico', 'evt_piloto', 'vodka-energetico', 'Vodka/energético', 'Vodka com energético', '🥃', '#ff5b00', 0, 4, 0);
INSERT OR IGNORE INTO inventory (event_id, product_id, initial_quantity)
VALUES ('evt_piloto', 'prd_jurupinga', 0), ('evt_piloto', 'prd_vodka_energetico', 0);
UPDATE events SET catalog_version = catalog_version + 1 WHERE id = 'evt_piloto';
