export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createPublicId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}_${toBase64Url(bytes)}`;
}

export function createRandomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = fromBase64Url(encodedKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY deve conter exatamente 32 bytes em Base64 URL-safe.");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string, encodedKey: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    await importEncryptionKey(encodedKey),
    new TextEncoder().encode(token)
  );
  return { ciphertext: toBase64Url(new Uint8Array(encrypted)), iv: toBase64Url(iv) };
}

export async function decryptToken(ciphertext: string, iv: string, encodedKey: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(fromBase64Url(iv)) },
    await importEncryptionKey(encodedKey),
    toArrayBuffer(fromBase64Url(ciphertext))
  );
  return new TextDecoder().decode(decrypted);
}

export function isoAfterMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function normalizeDigits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
