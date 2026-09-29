export type OperatorRole = "ADMIN" | "MARKETING" | "BARTENDER" | "EVENTOS";
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "EXPIRED" | "PAYMENT_EXCEPTION" | "CANCELLED";

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  EVENT_SLUG: string;
  PAYMENTS_MODE: "mock" | "pagbank";
  PAGBANK_API_BASE_URL: string;
  PAGBANK_TOKEN?: string;
  PAGBANK_WEBHOOK_PUBLIC_KEY?: string;
  TOKEN_ENCRYPTION_KEY: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface AuthenticatedOperator {
  id: string;
  eventId: string;
  displayName: string;
  role: OperatorRole;
  sessionId: string;
  deviceLabel: string;
}

export interface AppVariables {
  operator?: AuthenticatedOperator;
}

export type AppEnvironment = {
  Bindings: Bindings;
  Variables: AppVariables;
};

export interface OrderRow {
  id: string;
  public_id: string;
  event_id: string;
  kind: "PAYMENT" | "COURTESY";
  status: OrderStatus;
  access_token_hash: string;
  amount_cents: number;
  payment_provider: string | null;
  provider_order_id: string | null;
  provider_charge_id: string | null;
  pix_code: string | null;
  pix_image_url: string | null;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  total_cents: number;
}
