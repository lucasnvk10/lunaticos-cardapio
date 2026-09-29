import type { Bindings, OrderItemRow, OrderRow } from "../types";
import {
  ApiError,
  createId,
  createPublicId,
  createRandomToken,
  decryptToken,
  encryptToken,
  isUniqueConstraintError,
  isoAfterMinutes,
  sha256
} from "../utils";
import { createPaymentProvider } from "../payments/pagbank";
import type { PaymentStatusResult } from "../payments/types";

interface CreateOrderInput {
  eventSlug: string;
  idempotencyKey: string;
  accessToken: string;
  customer: { name: string; taxId: string; phone?: string };
  items: Array<{ productId: string; quantity: number }>;
}

interface ProductRow {
  id: string;
  event_id: string;
  name: string;
  unit_price_cents: number;
  active: number;
}

interface TicketMaterial {
  id: string;
  publicId: string;
  token: string;
  tokenHash: string;
  tokenCiphertext: string;
  tokenIv: string;
  orderItemId: string;
  productId: string;
  productName: string;
}

async function findEvent(bindings: Bindings, slug: string): Promise<{ id: string; name: string }> {
  const event = await bindings.DB.prepare("SELECT id, name FROM events WHERE slug = ? AND active = 1")
    .bind(slug).first<{ id: string; name: string }>();
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "O evento não está disponível.");
  return event;
}

function validateCreateOrderInput(input: CreateOrderInput): void {
  if (!/^[A-Za-z0-9_-]{16,120}$/.test(input.idempotencyKey)) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Identificador da compra inválido.");
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(input.accessToken)) throw new ApiError(400, "INVALID_ACCESS_TOKEN", "Token privado inválido.");
  if (!input.customer.name?.trim() || input.customer.name.trim().length > 120) throw new ApiError(400, "INVALID_CUSTOMER", "Informe seu nome.");
  if (!/^\d{11}$/.test(input.customer.taxId ?? "") || !isValidCpf(input.customer.taxId)) throw new ApiError(400, "INVALID_CPF", "Informe um CPF válido.");
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 20) throw new ApiError(400, "INVALID_CART", "Seu carrinho está vazio ou é muito grande.");
  const totalUnits = input.items.reduce((total, item) => total + Number(item.quantity), 0);
  if (totalUnits < 1 || totalUnits > 50 || input.items.some(item => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) {
    throw new ApiError(400, "INVALID_QUANTITY", "Revise as quantidades do carrinho.");
  }
}

function isValidCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) return false;
  const digits = [...cpf].map(Number);
  const firstCheck = (digits.slice(0, 9).reduce((sum, digit, index) => sum + digit * (10 - index), 0) * 10) % 11 % 10;
  const secondCheck = (digits.slice(0, 10).reduce((sum, digit, index) => sum + digit * (11 - index), 0) * 10) % 11 % 10;
  return firstCheck === digits[9] && secondCheck === digits[10];
}

async function loadProducts(bindings: Bindings, eventId: string, requestedItems: CreateOrderInput["items"]): Promise<ProductRow[]> {
  const uniqueIds = [...new Set(requestedItems.map(item => item.productId))];
  if (uniqueIds.length !== requestedItems.length) throw new ApiError(400, "DUPLICATE_PRODUCT", "O carrinho contém itens repetidos.");
  const placeholders = uniqueIds.map(() => "?").join(",");
  const result = await bindings.DB.prepare(`
    SELECT id, event_id, name, unit_price_cents, active
    FROM products WHERE event_id = ? AND id IN (${placeholders})
  `).bind(eventId, ...uniqueIds).all<ProductRow>();
  if (result.results.length !== uniqueIds.length || result.results.some(product => product.active !== 1)) {
    throw new ApiError(409, "PRODUCT_UNAVAILABLE", "Um produto do carrinho não está mais disponível.");
  }
  return result.results;
}

export async function createPaymentOrder(bindings: Bindings, rawInput: CreateOrderInput): Promise<Record<string, unknown>> {
  const input: CreateOrderInput = {
    ...rawInput,
    customer: {
      name: rawInput.customer?.name?.trim(),
      phone: rawInput.customer?.phone?.replace(/\D/g, '') || undefined,
      taxId: rawInput.customer?.taxId?.replace(/\D/g, "")
    }
  };
  validateCreateOrderInput(input);
  if (input.customer.phone && !/^\d{10,11}$/.test(input.customer.phone)) throw new ApiError(400,'INVALID_PHONE','Informe o telefone com DDD (10 ou 11 números).');
  const event = await findEvent(bindings, input.eventSlug);
  const accessTokenHash = await sha256(input.accessToken);
  const existing = await bindings.DB.prepare("SELECT * FROM orders WHERE event_id = ? AND idempotency_key = ?")
    .bind(event.id, input.idempotencyKey).first<OrderRow>();
  if (existing) {
    if (existing.access_token_hash !== accessTokenHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Esta tentativa de compra já foi usada.");
    return getOrderView(bindings, existing.public_id, input.accessToken);
  }

  const products = await loadProducts(bindings, event.id, input.items);
  const productMap = new Map(products.map(product => [product.id, product]));
  const canonicalItems = input.items.map(item => ({ ...item, product: productMap.get(item.productId)! }));
  const amountCents = canonicalItems.reduce((total, item) => total + item.product.unit_price_cents * item.quantity, 0);
  const orderId = createId("ord");
  const publicId = createPublicId("pedido");
  const reservationId = createId("res");
  const expiresAt = isoAfterMinutes(10);
  const orderItems = canonicalItems.map(item => ({
    id: createId("itm"),
    productId: item.product.id,
    productName: item.product.name,
    unitPriceCents: item.product.unit_price_cents,
    quantity: item.quantity,
    totalCents: item.product.unit_price_cents * item.quantity
  }));

  const statements: D1PreparedStatement[] = [
    bindings.DB.prepare(`
      INSERT INTO orders (
        id, public_id, event_id, kind, status, idempotency_key, access_token_hash, amount_cents,
        customer_name, customer_tax_id, customer_phone, expires_at
      ) VALUES (?, ?, ?, 'PAYMENT', 'PENDING_PAYMENT', ?, ?, ?, ?, ?, ?, ?)
    `).bind(orderId, publicId, event.id, input.idempotencyKey, accessTokenHash, amountCents, input.customer.name, input.customer.taxId, input.customer.phone ?? null, expiresAt),
    bindings.DB.prepare("INSERT INTO reservations (id, event_id, order_id, status, expires_at) VALUES (?, ?, ?, 'RESERVED', ?)")
      .bind(reservationId, event.id, orderId, expiresAt)
  ];
  for (const item of orderItems) {
    statements.push(
      bindings.DB.prepare(`
        INSERT INTO order_items (id, event_id, order_id, product_id, product_name, unit_price_cents, quantity, total_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(item.id, event.id, orderId, item.productId, item.productName, item.unitPriceCents, item.quantity, item.totalCents),
      bindings.DB.prepare(`
        UPDATE inventory SET reserved_quantity = reserved_quantity + ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ? AND product_id = ?
      `).bind(item.quantity, event.id, item.productId),
      bindings.DB.prepare(`
        INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reference_id)
        VALUES (?, ?, ?, 'RESERVE', ?, ?)
      `).bind(createId("mov"), event.id, item.productId, item.quantity, orderId)
    );
  }
  try {
    await bindings.DB.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrent = await bindings.DB.prepare("SELECT public_id, access_token_hash FROM orders WHERE event_id = ? AND idempotency_key = ?")
        .bind(event.id, input.idempotencyKey).first<{ public_id: string; access_token_hash: string }>();
      if (concurrent?.access_token_hash === accessTokenHash) return getOrderView(bindings, concurrent.public_id, input.accessToken);
    }
    throw new ApiError(409, "OUT_OF_STOCK", "Um item acabou de esgotar. Atualize o carrinho.");
  }

  try {
    const payment = await createPaymentProvider(bindings).createPix({
      internalOrderId: orderId,
      publicOrderId: publicId,
      amountCents,
      expiresAt,
      customer: input.customer,
      items: orderItems.map(item => ({ productId: item.productId, name: item.productName, quantity: item.quantity, unitPriceCents: item.unitPriceCents })),
      notificationUrl: `${bindings.APP_ORIGIN}/api/webhooks/pagbank`
    });
    await bindings.DB.batch([
      bindings.DB.prepare(`
        UPDATE orders SET payment_provider = ?, provider_order_id = ?, provider_charge_id = ?, pix_code = ?, pix_image_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(payment.provider, payment.providerOrderId, payment.providerChargeId, payment.pixCode, payment.pixImageUrl, orderId),
      bindings.DB.prepare(`
        INSERT INTO payments (id, event_id, order_id, provider, external_id, status, amount_cents, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(createId("pay"), event.id, orderId, payment.provider, payment.providerChargeId, payment.status, amountCents, payment.rawPayload)
    ]);
  } catch (error) {
    await releaseOrderReservation(bindings, orderId, "PAYMENT_PROVIDER_FAILED");
    throw error;
  }
  return getOrderView(bindings, publicId, input.accessToken);
}

async function buildTicketMaterials(bindings: Bindings, items: OrderItemRow[]): Promise<TicketMaterial[]> {
  const tickets: TicketMaterial[] = [];
  for (const item of items) {
    for (let unitIndex = 0; unitIndex < item.quantity; unitIndex += 1) {
      const token = createRandomToken();
      const encrypted = await encryptToken(token, bindings.TOKEN_ENCRYPTION_KEY);
      tickets.push({
        id: createId("tkt"),
        publicId: createPublicId("ficha"),
        token,
        tokenHash: await sha256(token),
        tokenCiphertext: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        orderItemId: item.id,
        productId: item.product_id,
        productName: item.product_name
      });
    }
  }
  return tickets;
}

function ticketInsertStatement(bindings: Bindings, order: OrderRow, ticket: TicketMaterial): D1PreparedStatement {
  return bindings.DB.prepare(`
    INSERT INTO tickets (
      id, public_id, event_id, order_id, order_item_id, product_id, product_name,
      token_hash, token_ciphertext, token_iv, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')
  `).bind(ticket.id, ticket.publicId, order.event_id, order.id, ticket.orderItemId, ticket.productId, ticket.productName, ticket.tokenHash, ticket.tokenCiphertext, ticket.tokenIv);
}

export async function markOrderPaid(bindings: Bindings, order: OrderRow, providerStatus: string, rawPayload: string): Promise<void> {
  if (order.status !== "PENDING_PAYMENT" && order.status !== "EXPIRED") return;
  const itemResult = await bindings.DB.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .bind(order.id).all<OrderItemRow>();
  const items = itemResult.results;
  const tickets = await buildTicketMaterials(bindings, items);
  const statements: D1PreparedStatement[] = [
    bindings.DB.prepare("INSERT INTO ticket_issuance_claims (order_id, event_id) VALUES (?, ?)")
      .bind(order.id, order.event_id)
  ];
  if (order.status === "PENDING_PAYMENT") {
    for (const item of items) {
      statements.push(
        bindings.DB.prepare(`
          UPDATE inventory SET reserved_quantity = reserved_quantity - ?, sold_quantity = sold_quantity + ?, updated_at = CURRENT_TIMESTAMP
          WHERE event_id = ? AND product_id = ?
        `).bind(item.quantity, item.quantity, order.event_id, item.product_id),
        bindings.DB.prepare(`
          INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reference_id)
          VALUES (?, ?, ?, 'SALE', ?, ?)
        `).bind(createId("mov"), order.event_id, item.product_id, item.quantity, order.id)
      );
    }
    statements.push(bindings.DB.prepare("UPDATE reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'RESERVED'").bind(order.id));
  } else {
    for (const item of items) {
      statements.push(
        bindings.DB.prepare(`
          UPDATE inventory SET sold_quantity = sold_quantity + ?, updated_at = CURRENT_TIMESTAMP
          WHERE event_id = ? AND product_id = ?
        `).bind(item.quantity, order.event_id, item.product_id),
        bindings.DB.prepare(`
          INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reference_id, reason)
          VALUES (?, ?, ?, 'LATE_SALE', ?, ?, 'Pagamento confirmado após expiração')
        `).bind(createId("mov"), order.event_id, item.product_id, item.quantity, order.id)
      );
    }
  }
  for (const ticket of tickets) statements.push(ticketInsertStatement(bindings, order, ticket));
  statements.push(
    bindings.DB.prepare("UPDATE orders SET status = 'PAID', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PENDING_PAYMENT', 'EXPIRED')").bind(order.id),
    bindings.DB.prepare("UPDATE payments SET status = ?, raw_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?")
      .bind(providerStatus, rawPayload.slice(0, 50_000), order.id)
  );
  try {
    await bindings.DB.batch(statements);
  } catch {
    const currentOrder = await bindings.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first<OrderRow>();
    if (!currentOrder || currentOrder.status === "PAID" || currentOrder.status === "PAYMENT_EXCEPTION" || currentOrder.status === "CANCELLED") return;
    if (order.status === "PENDING_PAYMENT" && currentOrder.status === "EXPIRED") {
      await markOrderPaid(bindings, currentOrder, providerStatus, rawPayload);
      return;
    }
    await bindings.DB.batch([
      bindings.DB.prepare("UPDATE orders SET status = 'PAYMENT_EXCEPTION', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PENDING_PAYMENT', 'EXPIRED')").bind(order.id),
      bindings.DB.prepare("UPDATE payments SET status = ?, raw_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?")
        .bind(providerStatus, rawPayload.slice(0, 50_000), order.id)
    ]);
  }
}

export async function reconcileOrderPayment(
  bindings: Bindings,
  order: OrderRow,
  payment: PaymentStatusResult
): Promise<void> {
  if (order.status === "PAID" || order.status === "CANCELLED" || order.status === "PAYMENT_EXCEPTION") return;

  if (payment.status === "PAID") {
    const paymentMatchesOrder = payment.providerOrderId === order.provider_order_id
      && payment.referenceId === order.id
      && payment.amountCents === order.amount_cents;
    if (!paymentMatchesOrder) {
      await bindings.DB.batch([
        bindings.DB.prepare("UPDATE orders SET status = 'PAYMENT_EXCEPTION', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PENDING_PAYMENT', 'EXPIRED')")
          .bind(order.id),
        bindings.DB.prepare("UPDATE payments SET status = 'PAYMENT_EXCEPTION', raw_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?")
          .bind(payment.rawPayload.slice(0, 50_000), order.id)
      ]);
      return;
    }
    await markOrderPaid(bindings, order, payment.status, payment.rawPayload);
    return;
  }

  await bindings.DB.prepare("UPDATE payments SET status = ?, raw_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?")
    .bind(payment.status, payment.rawPayload.slice(0, 50_000), order.id).run();
}

export async function releaseOrderReservation(bindings: Bindings, orderId: string, reason: string): Promise<boolean> {
  const order = await bindings.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order || order.status !== "PENDING_PAYMENT") return false;
  const items = (await bindings.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(orderId).all<OrderItemRow>()).results;
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    statements.push(
      bindings.DB.prepare(`
        UPDATE inventory SET reserved_quantity = reserved_quantity - ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ? AND product_id = ?
          AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'PENDING_PAYMENT')
      `).bind(item.quantity, order.event_id, item.product_id, orderId),
      bindings.DB.prepare(`
        INSERT INTO inventory_movements (id, event_id, product_id, movement_type, quantity, reference_id, reason)
        SELECT ?, ?, ?, 'RELEASE', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'PENDING_PAYMENT')
      `).bind(createId("mov"), order.event_id, item.product_id, item.quantity, orderId, reason, orderId)
    );
  }
  statements.push(
    bindings.DB.prepare("UPDATE reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'RESERVED'").bind(orderId),
    bindings.DB.prepare("UPDATE orders SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING_PAYMENT'").bind(orderId)
  );
  await bindings.DB.batch(statements);
  return true;
}

export async function expireReservations(bindings: Bindings, limit = 50): Promise<number> {
  const expired = await bindings.DB.prepare(`
    SELECT o.id FROM orders o JOIN reservations r ON r.order_id = o.id
    WHERE o.status = 'PENDING_PAYMENT' AND r.status = 'RESERVED' AND r.expires_at <= ?
    ORDER BY r.expires_at LIMIT ?
  `).bind(new Date().toISOString(), limit).all<{ id: string }>();
  let released = 0;
  for (const order of expired.results) if (await releaseOrderReservation(bindings, order.id, "RESERVATION_EXPIRED")) released += 1;
  return released;
}

export async function getOrderView(bindings: Bindings, publicId: string, accessToken: string): Promise<Record<string, unknown>> {
  const order = await bindings.DB.prepare("SELECT * FROM orders WHERE public_id = ?").bind(publicId).first<OrderRow>();
  if (!order || order.access_token_hash !== await sha256(accessToken)) throw new ApiError(404, "ORDER_NOT_FOUND", "Pedido não encontrado.");
  const items = (await bindings.DB.prepare("SELECT product_id, product_name, unit_price_cents, quantity, total_cents FROM order_items WHERE order_id = ? ORDER BY id")
    .bind(order.id).all<Record<string, unknown>>()).results;
  let tickets: Array<Record<string, unknown>> = [];
  if (order.status === "PAID") {
    const rows = (await bindings.DB.prepare(`
      SELECT public_id, product_id, product_name, token_ciphertext, token_iv, status, used_at
      FROM tickets WHERE order_id = ? ORDER BY product_name, created_at
    `).bind(order.id).all<{
      public_id: string;
      product_id: string;
      product_name: string;
      token_ciphertext: string;
      token_iv: string;
      status: string;
      used_at: string | null;
    }>()).results;
    tickets = await Promise.all(rows.map(async ticket => ({
      publicId: ticket.public_id,
      productId: ticket.product_id,
      productName: ticket.product_name,
      token: await decryptToken(ticket.token_ciphertext, ticket.token_iv, bindings.TOKEN_ENCRYPTION_KEY),
      status: ticket.status,
      usedAt: ticket.used_at
    })));
  }
  return {
    publicId: order.public_id,
    kind: order.kind,
    status: order.status,
    amountCents: order.amount_cents,
    pixCode: order.pix_code,
    pixImageUrl: order.pix_image_url,
    expiresAt: order.expires_at,
    paidAt: order.paid_at,
    createdAt: order.created_at,
    items: items.map(item => ({
      productId: item.product_id,
      productName: item.product_name,
      unitPriceCents: item.unit_price_cents,
      quantity: item.quantity,
      totalCents: item.total_cents
    })),
    tickets
  };
}
