export interface PaymentOrderInput {
  internalOrderId: string;
  publicOrderId: string;
  amountCents: number;
  expiresAt: string;
  customer: {
    name: string;
    taxId: string;
  };
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
  }>;
  notificationUrl: string;
}

export interface CreatedPixPayment {
  provider: "PAGBANK" | "MOCK";
  providerOrderId: string;
  providerChargeId: string;
  status: string;
  pixCode: string;
  pixImageUrl: string | null;
  rawPayload: string;
}

export interface PaymentStatusResult {
  providerOrderId: string;
  providerChargeId: string | null;
  referenceId: string | null;
  amountCents: number | null;
  status: "WAITING" | "PAID" | "DECLINED" | "CANCELLED" | "UNKNOWN";
  rawPayload: string;
}

export interface PaymentProvider {
  createPix(input: PaymentOrderInput): Promise<CreatedPixPayment>;
  getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult>;
}
