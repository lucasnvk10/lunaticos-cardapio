import type { Bindings } from "../types";
import { ApiError, createId, createPublicId, createRandomToken, encryptToken, sha256 } from "../utils";

interface CampaignRow {
  id: string;
  event_id: string;
  name: string;
  status: string;
  total_limit: number;
  used_quantity: number;
  quantity_per_use: number;
  starts_at: string;
  expires_at: string;
}

export async function redeemCourtesy(bindings: Bindings, input: {
  eventSlug: string;
  code: string;
  idempotencyKey: string;
  accessToken: string;
}): Promise<{ publicId: string }> {
  if (!input.code?.trim() || !input.idempotencyKey || !/^[A-Za-z0-9_-]{40,100}$/.test(input.accessToken ?? "")) {
    throw new ApiError(400, "INVALID_COURTESY", "Revise o código e o produto da cortesia.");
  }
  const event = await bindings.DB.prepare("SELECT id FROM events WHERE slug = ? AND active = 1").bind(input.eventSlug).first<{ id: string }>();
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Evento indisponível.");
  const accessTokenHash = await sha256(input.accessToken);
  const existing = await bindings.DB.prepare("SELECT public_id, access_token_hash FROM orders WHERE event_id = ? AND idempotency_key = ?")
    .bind(event.id, input.idempotencyKey).first<{ public_id: string; access_token_hash: string }>();
  if (existing) {
    if (existing.access_token_hash !== accessTokenHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Esta tentativa já foi utilizada.");
    return { publicId: existing.public_id };
  }
  const campaign = await bindings.DB.prepare(`
    SELECT * FROM courtesy_campaigns
    WHERE event_id = ? AND code_hash = ? AND status = 'ACTIVE' AND starts_at <= ? AND expires_at > ?
  `).bind(event.id, await sha256(input.code.trim().toUpperCase()), new Date().toISOString(), new Date().toISOString()).first<CampaignRow>();
  if (!campaign) throw new ApiError(404, "COURTESY_NOT_FOUND", "Código inválido ou fora da validade.");
  const allowedProducts = await bindings.DB.prepare(`
    SELECT p.id, p.name FROM products p
    JOIN courtesy_campaign_products cp ON cp.product_id = p.id
    WHERE cp.campaign_id = ? AND p.active = 1
    ORDER BY p.sort_order LIMIT 2
  `).bind(campaign.id).all<{ id: string; name: string }>();
  if (allowedProducts.results.length !== 1) throw new ApiError(409, "COURTESY_CONFIGURATION", "Este cupom precisa estar associado a um unico produto ativo.");
  const product = allowedProducts.results[0];
  const quantity = campaign.quantity_per_use;
  if (campaign.used_quantity + quantity > campaign.total_limit) throw new ApiError(409, "COURTESY_EXHAUSTED", "O limite desta cortesia acabou.");

  const orderId = createId("ord");
  const publicId = createPublicId("pedido");
  const orderItemId = createId("itm");
  const ticketStatements: D1PreparedStatement[] = [];
  for (let index = 0; index < quantity; index += 1) {
    const rawToken = createRandomToken();
    const encrypted = await encryptToken(rawToken, bindings.TOKEN_ENCRYPTION_KEY);
    ticketStatements.push(bindings.DB.prepare(`
      INSERT INTO tickets (
        id, public_id, event_id, order_id, order_item_id, product_id, product_name,
        token_hash, token_ciphertext, token_iv, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')
    `).bind(createId("tkt"), createPublicId("ficha"), event.id, orderId, orderItemId, product.id, product.name, await sha256(rawToken), encrypted.ciphertext, encrypted.iv));
  }
  try {
    await bindings.DB.batch([
      bindings.DB.prepare(`
        UPDATE courtesy_campaigns
        SET used_quantity = used_quantity + ?,
            status = CASE WHEN used_quantity + ? = total_limit THEN 'EXHAUSTED' ELSE status END
        WHERE id = ?
      `).bind(quantity, quantity, campaign.id),
      bindings.DB.prepare(`
        UPDATE inventory SET courtesy_quantity = courtesy_quantity + ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ? AND product_id = ?
      `).bind(quantity, event.id, product.id),
      bindings.DB.prepare(`
        INSERT INTO orders (id, public_id, event_id, kind, status, idempotency_key, access_token_hash, amount_cents, paid_at)
        VALUES (?, ?, ?, 'COURTESY', 'PAID', ?, ?, 0, CURRENT_TIMESTAMP)
      `).bind(orderId, publicId, event.id, input.idempotencyKey, accessTokenHash),
      bindings.DB.prepare(`
        INSERT INTO order_items (id, event_id, order_id, product_id, product_name, unit_price_cents, quantity, total_cents)
        VALUES (?, ?, ?, ?, ?, 0, ?, 0)
      `).bind(orderItemId, event.id, orderId, product.id, product.name, quantity),
      bindings.DB.prepare(`
        INSERT INTO courtesy_redemptions (id, event_id, campaign_id, order_id, quantity)
        VALUES (?, ?, ?, ?, ?)
      `).bind(createId("cor"), event.id, campaign.id, orderId, quantity),
      bindings.DB.prepare(`
        INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reference_id)
        VALUES (?, ?, ?, 'COURTESY', ?, ?)
      `).bind(createId("mov"), event.id, product.id, quantity, orderId),
      ...ticketStatements
    ]);
  } catch {
    throw new ApiError(409, "COURTESY_UNAVAILABLE", "A cortesia ou o estoque acabou durante a solicitação.");
  }
  return { publicId };
}

