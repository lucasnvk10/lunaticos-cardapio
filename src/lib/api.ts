export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } } & T;
  if (!response.ok) {
    throw new ApiClientError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "Não foi possível concluir.", response.status);
  }
  return payload;
}

export async function apiGet<T>(path: string, options?: RequestInit): Promise<T> {
  return parseResponse<T>(await fetch(path, { credentials: "include", ...options }));
}

export async function apiPost<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
  return parseResponse<T>(await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...options
  }));
}

export function createBrowserToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function money(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
}
