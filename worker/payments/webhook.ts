import type { Bindings } from "../types";
import { fromBase64Url, toArrayBuffer } from "../utils";

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("\n", "").replaceAll("\r", "").trim();
  try {
    return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
  } catch {
    return fromBase64Url(normalized);
  }
}

function normalizeDerEcdsaSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64 || signature[0] !== 0x30) return signature;
  let offset = 1;
  const sequenceLength = signature[offset] & 0x80
    ? signature.slice(offset + 1, offset + 1 + (signature[offset] & 0x7f)).reduce((length, byte) => length * 256 + byte, 0)
    : signature[offset];
  offset += signature[offset] & 0x80 ? 1 + (signature[offset] & 0x7f) : 1;
  if (sequenceLength <= 0 || signature[offset++] !== 0x02) return signature;
  const rLength = signature[offset++];
  const r = signature.slice(offset, offset + rLength);
  offset += rLength;
  if (signature[offset++] !== 0x02) return signature;
  const sLength = signature[offset++];
  const s = signature.slice(offset, offset + sLength);
  const normalized = new Uint8Array(64);
  const cleanR = r[0] === 0 ? r.slice(1) : r;
  const cleanS = s[0] === 0 ? s.slice(1) : s;
  if (cleanR.length > 32 || cleanS.length > 32) return signature;
  normalized.set(cleanR, 32 - cleanR.length);
  normalized.set(cleanS, 64 - cleanS.length);
  return normalized;
}

export async function verifyPagBankWebhook(
  bindings: Bindings,
  rawBody: string,
  signatureHeaders: string[]
): Promise<boolean> {
  if (bindings.PAYMENTS_MODE === "mock") return true;
  if (!bindings.PAGBANK_WEBHOOK_PUBLIC_KEY || signatureHeaders.length === 0) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(decodeBase64(bindings.PAGBANK_WEBHOOK_PUBLIC_KEY)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const bodyBytes = new TextEncoder().encode(rawBody);
    for (const signature of signatureHeaders) {
      const normalizedSignature = normalizeDerEcdsaSignature(decodeBase64(signature));
      const isValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        toArrayBuffer(normalizedSignature),
        bodyBytes
      );
      if (isValid) return true;
    }
    return false;
  } catch {
    return false;
  }
}
