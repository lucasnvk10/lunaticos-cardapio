INSERT OR IGNORE INTO events (id, slug, name, subtitle, active)
VALUES ('evt_piloto', 'evento-piloto', 'Lunáticos UFPR', 'Compre pelo celular e retire sem fila', 1);

INSERT OR IGNORE INTO products (id, event_id, slug, name, description, emoji, color, unit_price_cents, sort_order, active)
VALUES
  ('prd_cerveja', 'evt_piloto', 'chopp', 'Chopp', 'Chopp gelado', '🍺', '#ff5b00', 900, 1, 1),
  ('prd_chevette', 'evt_piloto', 'chevette', 'Chevette', 'Chevette', '🍹', '#ff5b00', 500, 2, 1),
  ('prd_jurupinga', 'evt_piloto', 'jurupinga', 'Jurupinga', 'Jurupinga', '🍷', '#ff5b00', 1000, 3, 1),
  ('prd_vodka_energetico', 'evt_piloto', 'vodka-energetico', 'Vodka com energético', 'Vodka com energético', '🥃', '#ff5b00', 600, 4, 1),
  ('prd_gummy', 'evt_piloto', 'gummy', 'Gummy', 'Gummy', '🍬', '#ff5b00', 500, 5, 1);

INSERT OR IGNORE INTO inventory (event_id, product_id, initial_quantity)
VALUES
  ('evt_piloto', 'prd_cerveja', 2000),
  ('evt_piloto', 'prd_chevette', 1000),
  ('evt_piloto', 'prd_jurupinga', 0),
  ('evt_piloto', 'prd_vodka_energetico', 0),
  ('evt_piloto', 'prd_gummy', 800);
