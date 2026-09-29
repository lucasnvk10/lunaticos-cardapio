import { describe, expect, it } from "vitest";
import { operationalReportCsv, type OperationalReport } from "../worker/services/admin";

describe("relatório geral CSV", () => {
  it("inclui resumo, vendas, fichas e estoque inicial e final em um único arquivo", () => {
    const report: OperationalReport = {
      generatedAt: "2026-09-24T12:00:00.000Z",
      summary: {
        revenueCents: 1800, paidOrders: 2, paidUnits: 3, courtesyUnits: 1,
        totalTickets: 4, availableTickets: 2, usedTickets: 1, cancelledTickets: 1
      },
      salesByProduct: [{ productId: "drink-1", productName: "Vodka, energético", paidUnits: 3, courtesyUnits: 1, revenueCents: 1800 }],
      detailedSales: [{
        orderPublicId: "order-1", createdAt: "2026-09-24T11:00:00.000Z", customerName: "=SUM(A1:A2)", customerCpf: "52998224725",
        productName: "Vodka, energético", quantity: 3, unitPriceCents: 600, totalCents: 1800, paymentMethod: "PIX", orderStatus: "PAID"
      }],
      ticketStatuses: [{
        ticketCode: "ticket-1", orderPublicId: "order-1", productName: "Vodka, energético", status: "AVAILABLE",
        purchasedAt: "2026-09-24T11:00:00.000Z", usedAt: ""
      }],
      stockSummary: [{
        productId: "drink-1", productName: "Vodka, energético", startingStock: 20, adjustments: 2, paidUnits: 3,
        courtesyUnits: 1, withdrawnUnits: 1, reservedUnits: 0, endingPhysicalStock: 21, availableForSale: 18
      }]
    };

    const csv = operationalReportCsv(report, "general");

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"1. RESUMO DE VENDAS"');
    expect(csv).toContain('"2. VENDAS DETALHADAS"');
    expect(csv).toContain('"3. STATUS DAS FICHAS"');
    expect(csv).toContain('"4. RESUMO DE ESTOQUE"');
    expect(csv).toContain('"Estoque inicial","Ajustes líquidos","Unidades vendidas"');
    expect(csv).toContain('"20","2","3","1","1","0","21","18"');
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain('"Vodka, energético"');
  });
});

