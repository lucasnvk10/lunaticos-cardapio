import type { Bindings } from "../types";
import { ApiError, createId } from "../utils";
import type { CreatedPixPayment, PaymentOrderInput, PaymentProvider, PaymentStatusResult } from "./types";

function mapStatus(status: string | undefined): PaymentStatusResult["status"] {
  switch (status?.toUpperCase()) {
    case "PAID": return "PAID";
    case "WAITING":
    case "AUTHORIZED":
    case "IN_ANALYSIS": return "WAITING";
    case "DECLINED": return "DECLINED";
    case "CANCELED":
    case "CANCELLED":
    case "REFUNDED":
    case "CHARGEBACK": return "CANCELLED";
    default: return "UNKNOWN";
  }
}

export class MockPaymentProvider implements PaymentProvider {
  async createPix(input: PaymentOrderInput): Promise<CreatedPixPayment> {
    const providerOrderId = createId("mock_order");
    const providerChargeId = createId("mock_charge");
    return {
      provider: "MOCK",
      providerOrderId,
      providerChargeId,
      status: "WAITING",
      pixCode: `PIX-SIMULADO-${input.publicOrderId}-${input.amountCents}`,
      pixImageUrl: null,
      rawPayload: JSON.stringify({ providerOrderId, providerChargeId, status: "WAITING" })
    };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    return { providerOrderId, providerChargeId: null, referenceId: null, amountCents: null, status: "WAITING", rawPayload: "{}" };
  }
}

export class PagBankPaymentProvider implements PaymentProvider {
  constructor(private readonly bindings: Bindings) {}

  async createPix(input: PaymentOrderInput): Promise<CreatedPixPayment> {
    if (!this.bindings.PAGBANK_TOKEN) throw new ApiError(503, "PAGBANK_NOT_CONFIGURED", "O PagBank ainda não foi configurado.");
    const body = {
      reference_id: input.internalOrderId,
      customer: {
        name: input.customer.name,
        tax_id: input.customer.taxId
      },
      items: input.items.map(item => ({
        reference_id: item.productId,
        name: item.name,
        quantity: item.quantity,
        unit_amount: item.unitPriceCents
      })),
      charges: [{
        reference_id: input.internalOrderId,
        description: `Pedido ${input.publicOrderId}`,
        amount: { value: input.amountCents, currency: "BRL" },
        payment_method: { type: "PIX", pix: { expiration_date: input.expiresAt } }
      }],
      notification_urls: [input.notificationUrl]
    };
    const response = await fetch(`${this.bindings.PAGBANK_API_BASE_URL}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bindings.PAGBANK_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-idempotency-key": input.internalOrderId
      },
      body: JSON.stringify(body)
    });
    const rawPayload = await response.text();
    if (!response.ok) throw new ApiError(502, "PAGBANK_CREATE_FAILED", "O PagBank não conseguiu criar o Pix. Tente novamente.");
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    const charges = payload.charges as Array<Record<string, unknown>> | undefined;
    const charge = charges?.[0];
    const qrCode = charge?.qr_code as Record<string, unknown> | undefined;
    const links = charge?.links as Array<Record<string, string>> | undefined;
    const pixCode = String(qrCode?.text ?? "");
    if (!payload.id || !charge?.id || !pixCode) throw new ApiError(502, "PAGBANK_INVALID_RESPONSE", "O PagBank retornou um Pix incompleto.");
    return {
      provider: "PAGBANK",
      providerOrderId: String(payload.id),
      providerChargeId: String(charge.id),
      status: String(charge.status ?? "WAITING"),
      pixCode,
      pixImageUrl: links?.find(link => link.rel === "QRCODE.PNG")?.href ?? null,
      rawPayload
    };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    if (!this.bindings.PAGBANK_TOKEN) throw new ApiError(503, "PAGBANK_NOT_CONFIGURED", "O PagBank ainda não foi configurado.");
    const response = await fetch(`${this.bindings.PAGBANK_API_BASE_URL}/orders/${encodeURIComponent(providerOrderId)}`, {
      headers: { Authorization: `Bearer ${this.bindings.PAGBANK_TOKEN}`, Accept: "application/json" }
    });
    const rawPayload = await response.text();
    if (!response.ok) throw new ApiError(502, "PAGBANK_STATUS_FAILED", "Não foi possível consultar o pagamento.");
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    const charge = (payload.charges as Array<Record<string, unknown>> | undefined)?.[0];
    const amount = charge?.amount as Record<string, unknown> | undefined;
    const amountValue = Number(amount?.value);
    return {
      providerOrderId: String(payload.id ?? providerOrderId),
      providerChargeId: charge?.id ? String(charge.id) : null,
      referenceId: payload.reference_id ? String(payload.reference_id) : null,
      amountCents: Number.isSafeInteger(amountValue) ? amountValue : null,
      status: mapStatus(charge?.status ? String(charge.status) : undefined),
      rawPayload
    };
  }
}

export function createPaymentProvider(bindings: Bindings): PaymentProvider {
  return bindings.PAYMENTS_MODE === "pagbank" ? new PagBankPaymentProvider(bindings) : new MockPaymentProvider();
}
