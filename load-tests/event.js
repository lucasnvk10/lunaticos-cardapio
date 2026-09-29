import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const baseUrl = __ENV.BASE_URL || "http://localhost:8787";
const apiFailures = new Counter("api_failures");

export const options = {
  scenarios: {
    static_visitors: {
      executor: "ramping-vus",
      exec: "browseMenu",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 1000 },
        { duration: "15m", target: 1000 },
        { duration: "1m", target: 0 }
      ]
    },
    pix_orders: {
      executor: "shared-iterations",
      exec: "createOrder",
      vus: 40,
      iterations: 300,
      maxDuration: "5m",
      startTime: "2m"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2000"],
    api_failures: ["count==0"]
  }
};

export function browseMenu() {
  const response = http.get(`${baseUrl}/`);
  check(response, { "site abriu": result => result.status === 200 });
  sleep(Math.random() * 3 + 2);
}

export function createOrder() {
  const suffix = `${__VU}${__ITER}${Date.now()}`;
  const catalog = http.get(`${baseUrl}/api/catalog`);
  const catalogOk = check(catalog, { "catálogo respondeu": result => result.status === 200 });
  if (!catalogOk) { apiFailures.add(1); return; }
  const products = catalog.json("products");
  const response = http.post(`${baseUrl}/api/orders`, JSON.stringify({
    idempotencyKey: `loadtest_${suffix}`,
    accessToken: `loadtesttoken${suffix}`.padEnd(48, "x"),
    customer: { name: "Teste de Carga", email: `carga-${suffix}@example.com`, taxId: "12345678901", phone: "11999999999" },
    items: [{ productId: products[__ITER % products.length].id, quantity: 1 }]
  }), { headers: { "Content-Type": "application/json" } });
  const ok = check(response, { "pedido criado": result => result.status === 201 });
  if (!ok) apiFailures.add(1);
}
