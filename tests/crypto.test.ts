import { describe, expect, it } from "vitest";
import { createRandomToken, decryptToken, encryptToken, sha256, toBase64Url } from "../worker/utils";

describe("tokens protegidos", () => {
  it("gera tokens de 256 bits e hashes estáveis", async () => {
    const token = createRandomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(await sha256(token)).toBe(await sha256(token));
    expect(await sha256(token)).not.toBe(await sha256(createRandomToken()));
  });

  it("cifra e recupera o token da ficha", async () => {
    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const token = createRandomToken();
    const encrypted = await encryptToken(token, key);
    expect(encrypted.ciphertext).not.toContain(token);
    await expect(decryptToken(encrypted.ciphertext, encrypted.iv, key)).resolves.toBe(token);
  });
});
