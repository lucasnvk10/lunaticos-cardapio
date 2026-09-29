import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnvironment, AuthenticatedOperator, OperatorRole } from "./types";
import { ApiError, createId, createRandomToken, isoAfterMinutes, sha256 } from "./utils";

const SESSION_COOKIE = "event_staff_session";
const PASSWORD_ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = new Uint8Array(salt).buffer as ArrayBuffer;
  const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, passwordKey, 256);
  return bytesToBase64(new Uint8Array(derivedBits));
}

export async function createPasswordCredential(password: string): Promise<{ salt: string; hash: string; iterations: number }> {
  if (password.length < 10 || password.length > 128) throw new ApiError(400, "INVALID_PASSWORD", "A senha deve ter entre 10 e 128 caracteres.");
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: bytesToBase64(saltBytes),
    hash: await derivePasswordHash(password, saltBytes, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS
  };
}

export async function verifyPasswordCredential(password: string, salt: string, expectedHash: string, iterations: number): Promise<boolean> {
  const actualHash = await derivePasswordHash(password, base64ToBytes(salt), iterations);
  if (actualHash.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  return difference === 0;
}

export async function resolveOperator(context: Context<AppEnvironment>): Promise<AuthenticatedOperator | null> {
  const rawToken = getCookie(context, SESSION_COOKIE);
  if (!rawToken) return null;
  const tokenHash = await sha256(rawToken);
  const row = await context.env.DB.prepare(`
    SELECT s.id AS session_id, s.event_id, s.device_label, o.id AS operator_id, o.display_name, o.role
    FROM operator_sessions s
    JOIN operators o ON o.id = s.operator_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP AND o.active = 1
  `).bind(tokenHash).first<{
    session_id: string;
    event_id: string;
    device_label: string;
    operator_id: string;
    display_name: string;
    role: OperatorRole;
  }>();
  if (!row) return null;
  return {
    id: row.operator_id,
    eventId: row.event_id,
    displayName: row.display_name,
    role: row.role,
    sessionId: row.session_id,
    deviceLabel: row.device_label
  };
}

export const optionalAuthentication = createMiddleware<AppEnvironment>(async (context, next) => {
  const operator = await resolveOperator(context);
  if (operator) context.set("operator", operator);
  await next();
});

export function requireRoles(...roles: OperatorRole[]) {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    const operator = context.get("operator") ?? await resolveOperator(context);
    if (!operator) throw new ApiError(401, "AUTH_REQUIRED", "Entre na área da equipe para continuar.");
    if (!roles.includes(operator.role)) throw new ApiError(403, "ROLE_FORBIDDEN", "Seu perfil não permite esta ação.");
    context.set("operator", operator);
    await next();
  });
}

export async function createOperatorSession(
  context: Context<AppEnvironment>,
  operatorId: string,
  eventId: string,
  deviceLabel: string
): Promise<void> {
  const rawToken = createRandomToken();
  const sessionId = createId("ses");
  const expiresAt = isoAfterMinutes(60 * 24 * 7);
  await context.env.DB.prepare(`
    INSERT INTO operator_sessions (id, event_id, operator_id, token_hash, device_label, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(sessionId, eventId, operatorId, await sha256(rawToken), deviceLabel.slice(0, 80), expiresAt).run();
  setCookie(context, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export async function revokeCurrentSession(context: Context<AppEnvironment>): Promise<void> {
  const operator = context.get("operator");
  if (operator) {
    await context.env.DB.prepare("UPDATE operator_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(operator.sessionId).run();
  }
  deleteCookie(context, SESSION_COOKIE, { path: "/" });
}
