import type { AuthenticatedOperator, Bindings } from '../types';
import { ApiError, createId } from '../utils';

export interface StockInput { stockUnit?: string; stockAmount?: number; portionMl?: number; lowStockThreshold?: number }
export function calculateStock(input: StockInput) {
  const unit = input.stockUnit ?? 'UNIT';
  const amount = Number(input.stockAmount);
  const portion = unit === 'UNIT' ? 0 : Number(input.portionMl);
  const threshold = input.lowStockThreshold === undefined ? 10 : Number(input.lowStockThreshold);
  const volume = unit === 'L' ? Math.round(amount * 1000) : unit === 'ML' ? amount : 0;
  if (!['UNIT', 'L', 'ML'].includes(unit) || !Number.isFinite(amount) || amount < 0 ||
      (unit === 'UNIT' && !Number.isInteger(amount)) ||
      (unit !== 'UNIT' && (!Number.isSafeInteger(volume) || Math.abs(amount * (unit === 'L' ? 1000 : 1) - volume) > 0.000001 || !Number.isInteger(portion) || portion < 1 || portion > 10000)) ||
      !Number.isInteger(threshold) || threshold < 0 || threshold > 100000) {
    throw new ApiError(400, 'INVALID_STOCK', 'Informe estoque, tamanho do copo e limite de alerta válidos.');
  }
  const capacity = unit === 'UNIT' ? amount : Math.floor(volume / portion);
  if (capacity > 100000 || volume > 100000000) throw new ApiError(400, 'INVALID_STOCK', 'O estoque excede o limite permitido.');
  return { unit, volume, portion, threshold, capacity };
}

export async function configureStock(env: Bindings, operator: AuthenticatedOperator, productId: string, input: StockInput) {
  const stock = calculateStock(input);
  // A conditional update guards against a purchase arriving after the form was opened.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE inventory SET initial_quantity = ?, initial_volume_ml = ?, updated_at = CURRENT_TIMESTAMP
      WHERE event_id = ? AND product_id = ? AND reserved_quantity = 0 AND sold_quantity = 0
      AND courtesy_quantity = 0 AND redeemed_quantity = 0 AND adjustment_quantity = 0 AND adjustment_volume_ml = 0
      RETURNING product_id`).bind(stock.capacity, stock.volume, operator.eventId, productId),
    env.DB.prepare(`UPDATE products SET stock_unit = ?, portion_ml = ?, low_stock_threshold = ?, updated_at = CURRENT_TIMESTAMP
      WHERE event_id = ? AND id = ? AND EXISTS (SELECT 1 FROM inventory WHERE event_id = ? AND product_id = ?
      AND reserved_quantity = 0 AND sold_quantity = 0 AND courtesy_quantity = 0 AND redeemed_quantity = 0
      AND adjustment_quantity = 0 AND adjustment_volume_ml = 0)`).bind(stock.unit, stock.portion, stock.threshold, operator.eventId, productId, operator.eventId, productId),
    env.DB.prepare(`INSERT INTO audit_logs (id, event_id, operator_id, action, entity_type, entity_id, details)
      SELECT ?, ?, ?, 'CONFIGURE_STOCK', 'PRODUCT', ?, ? WHERE changes() > 0`)
      .bind(createId('aud'), operator.eventId, operator.id, productId, JSON.stringify(stock))
  ]);
  if (!result[0].results.length) throw new ApiError(409, 'STOCK_IN_USE', 'O estoque já tem movimentação. Use reposição ou perda; o tamanho do copo não pode mudar durante as vendas.');
}

export async function adjustVolumeStock(env: Bindings, operator: AuthenticatedOperator, productId: string, amount: number, reason: string) {
  const product = await env.DB.prepare('SELECT stock_unit, portion_ml FROM products WHERE event_id = ? AND id = ?')
    .bind(operator.eventId, productId).first<{ stock_unit: string; portion_ml: number }>();
  if (!product || product.stock_unit === 'UNIT') throw new ApiError(400, 'INVALID_VOLUME_PRODUCT', 'Esta bebida não usa estoque por volume.');
  const rawMl = amount * (product.stock_unit === 'L' ? 1000 : 1);
  const ml = Math.round(rawMl);
  if (!Number.isFinite(rawMl) || Math.abs(rawMl - ml) > 0.000001 || ml === 0 || Math.abs(ml) > 100000000 || !reason?.trim())
    throw new ApiError(400, 'INVALID_ADJUSTMENT', 'Informe um volume e o motivo da reposição ou perda.');
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE inventory SET adjustment_volume_ml = adjustment_volume_ml + ?,
        adjustment_quantity = CAST((initial_volume_ml + adjustment_volume_ml + ?) / ? AS INTEGER) - initial_quantity,
        updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND product_id = ?
        AND initial_volume_ml + adjustment_volume_ml + ? BETWEEN 0 AND 100000000
        AND CAST((initial_volume_ml + adjustment_volume_ml + ?) / ? AS INTEGER) BETWEEN 0 AND 100000
        RETURNING product_id`).bind(ml, ml, product.portion_ml, operator.eventId, productId, ml, ml, product.portion_ml),
      env.DB.prepare(`INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reason, operator_id)
        SELECT ?, ?, ?, 'ADJUSTMENT', ?, ?, ? WHERE changes() > 0`)
        .bind(createId('mov'), operator.eventId, productId, ml, `${reason.trim().slice(0, 250)} (${ml} ml)`, operator.id)
    ]);
    if (!result[0].results.length) throw new Error('invalid result');
  } catch { throw new ApiError(409, 'INVALID_STOCK_RESULT', 'A perda comprometeria fichas emitidas ou o volume excede o limite permitido.'); }
}
