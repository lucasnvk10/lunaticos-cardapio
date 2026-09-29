import { describe, expect, it } from "vitest";
import { createPasswordCredential, verifyPasswordCredential } from "../worker/auth";

describe("admin password credentials", () => {
  it("accepts the original password and rejects a different one", async () => {
    const credential = await createPasswordCredential("senha-segura-123");

    await expect(verifyPasswordCredential("senha-segura-123", credential.salt, credential.hash, credential.iterations)).resolves.toBe(true);
    await expect(verifyPasswordCredential("senha-incorreta", credential.salt, credential.hash, credential.iterations)).resolves.toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(createPasswordCredential("curta")).rejects.toThrow("10 e 128");
  });
});
