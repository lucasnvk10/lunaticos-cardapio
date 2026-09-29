export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  unit_price_cents: number;
  available_quantity: number;
}

export interface Catalog {
  event: {
    id: string;
    slug: string;
    name: string;
    subtitle: string;
    catalog_version: number;
  };
  products: CatalogProduct[];
}

export interface OrderTicket {
  publicId: string;
  productId: string;
  productName: string;
  token: string;
  status: "AVAILABLE" | "USED" | "CANCELLED";
  usedAt: string | null;
}

export interface OrderView {
  publicId: string;
  kind: "PAYMENT" | "COURTESY";
  status: "PENDING_PAYMENT" | "PAID" | "EXPIRED" | "PAYMENT_EXCEPTION" | "CANCELLED";
  amountCents: number;
  pixCode: string | null;
  pixImageUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  items: Array<{
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    totalCents: number;
  }>;
  tickets: OrderTicket[];
}

export interface StaffSession {
  authenticated: boolean;
  setupRequired?: boolean;
  operator?: {
    id: string;
    displayName: string;
    role: "ADMIN" | "MARKETING" | "BARTENDER" | "EVENTOS";
    deviceLabel: string;
  };
}
