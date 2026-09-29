import { describe, expect, it } from "vitest";
import { MockPaymentProvider, PagBankPaymentProvider } from "../worker/payments/pagbank";
import type { Bindings, OrderRow } from "../worker/types";
import { reconcileOrderPayment } from "../worker/services/orders";

describe("provedores de pagamento", () => {
  it("recusa criar um Pix quando o token real do PagBank nao esta configurado", async () => {
    const provider = new PagBankPaymentProvider({
      PAGBANK_API_BASE_URL: "https://api.pagseguro.com"
    } as unknown as Bindings);
    await expect(provider.createPix({
      internalOrderId: "ord_test",
      publicOrderId: "pedido_test",
      amountCents: 900,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      customer: { name: "Pessoa Teste", taxId: "52998224725" },
      items: [{ productId: "prd_test", name: "Chopp", quantity: 1, unitPriceCents: 900 }],
      notificationUrl: "https://evento.test/api/webhooks/pagbank"
    })).rejects.toMatchObject({ code: "PAGBANK_NOT_CONFIGURED", status: 503 });
  });

  it("cria um Pix pendente com referência única", async () => {
    const provider = new MockPaymentProvider();
    const result = await provider.createPix({
      internalOrderId: "ord_test",
      publicOrderId: "pedido_test",
      amountCents: 1800,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      customer: { name: "Pessoa Teste", taxId: "52998224725" },
      items: [{ productId: "prd_test", name: "Produto", quantity: 2, unitPriceCents: 900 }],
      notificationUrl: "http://localhost/webhook"
    });
    expect(result.status).toBe("WAITING");
    expect(result.pixCode).toContain("pedido_test");
    expect(result.providerOrderId).not.toBe(result.providerChargeId);
  });

  it("cria a cobrança Pix no PagBank pelo valor do pedido e com o CPF informado", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "ORDE_REAL_TESTE",
        charges: [{
          id: "CHAR_REAL_TESTE",
          status: "WAITING",
          qr_code: { text: "000201PIX-GERADO-PELO-PAGBANK" },
          links: [{ rel: "QRCODE.PNG", href: "https://pagbank.test/qr.png" }]
        }]
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    };
    try {
      const provider = new PagBankPaymentProvider({
        PAGBANK_TOKEN: "token-apenas-de-teste",
        PAGBANK_API_BASE_URL: "https://api.pagseguro.com"
      } as unknown as Bindings);
      const result = await provider.createPix({
        internalOrderId: "ord_test",
        publicOrderId: "pedido_test",
        amountCents: 900,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        customer: { name: "Pessoa Teste", taxId: "52998224725" },
        items: [{ productId: "prd_test", name: "Chopp", quantity: 1, unitPriceCents: 900 }],
        notificationUrl: "https://evento.test/api/webhooks/pagbank"
      });
      const customer = requestBody.customer as Record<string, unknown>;
      const charges = requestBody.charges as Array<Record<string, unknown>>;
      const chargeAmount = charges[0].amount as Record<string, unknown>;
      expect(requestUrl).toBe("https://api.pagseguro.com/orders");
      expect(customer.tax_id).toBe("52998224725");
      expect(chargeAmount).toEqual({ value: 900, currency: "BRL" });
      expect(result.pixCode).toBe("000201PIX-GERADO-PELO-PAGBANK");
      expect(result.provider).toBe("PAGBANK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconcilia o status PagBank com referência e valor retornados pela API", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "ORDE_TESTE",
      reference_id: "ord_teste",
      charges: [{ id: "CHAR_TESTE", status: "PAID", amount: { value: 1400 } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const provider = new PagBankPaymentProvider({
        PAGBANK_TOKEN: "sandbox-token",
        PAGBANK_API_BASE_URL: "https://sandbox.api.pagseguro.com"
      } as unknown as Bindings);
      await expect(provider.getPaymentStatus("ORDE_TESTE")).resolves.toMatchObject({
        providerOrderId: "ORDE_TESTE",
        providerChargeId: "CHAR_TESTE",
        referenceId: "ord_teste",
        amountCents: 1400,
        status: "PAID"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("não emite fichas se a confirmação paga não corresponder ao pedido", async () => {
    const statements: Array<{ sql: string }> = [];
    const fakeDatabase = {
      prepare(sql: string) {
        return { sql, bind() { return this; } };
      },
      async batch(batchStatements: Array<{ sql: string }>) {
        statements.push(...batchStatements);
      }
    };
    const order = {
      id: "ord_teste",
      event_id: "evt_teste",
      status: "PENDING_PAYMENT",
      provider_order_id: "ORDE_TESTE",
      amount_cents: 1400
    } as OrderRow;

    await reconcileOrderPayment({ DB: fakeDatabase } as unknown as Bindings, order, {
      providerOrderId: "ORDE_TESTE",
      providerChargeId: "CHAR_TESTE",
      referenceId: "ord_teste",
      amountCents: 1000,
      status: "PAID",
      rawPayload: "{}"
    });

    expect(statements.map(statement => statement.sql).join("\n")).toContain("status = 'PAYMENT_EXCEPTION'");
    expect(statements.some(statement => statement.sql.includes("INSERT INTO tickets"))).toBe(false);
  });
});

