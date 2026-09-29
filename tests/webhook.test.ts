import { describe, expect, it } from "vitest";
import type { Bindings } from "../worker/types";
import { verifyPagBankWebhook } from "../worker/payments/webhook";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array) => {
    let first = 0;
    while (first < value.length - 1 && value[first] === 0) first += 1;
    let clean = value.slice(first);
    if ((clean[0] & 0x80) !== 0) clean = Uint8Array.from([0, ...clean]);
    return Uint8Array.from([0x02, clean.length, ...clean]);
  };
  const r = encodeInteger(raw.slice(0, 32));
  const s = encodeInteger(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

describe("assinatura do webhook PagBank", () => {
  it("aceita ECDSA DER autêntico e recusa corpo alterado", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const body = JSON.stringify({ id: "ORDE_TEST", status: "PAID" });
    const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(body)));
    const bindings = {
      PAYMENTS_MODE: "pagbank",
      PAGBANK_WEBHOOK_PUBLIC_KEY: base64(publicKey)
    } as unknown as Bindings;
    const signature = base64(rawSignatureToDer(rawSignature));
    await expect(verifyPagBankWebhook(bindings, body, [signature])).resolves.toBe(true);
    await expect(verifyPagBankWebhook(bindings, `${body} `, [signature])).resolves.toBe(false);
  });
});
