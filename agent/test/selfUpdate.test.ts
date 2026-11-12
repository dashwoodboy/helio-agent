import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyBundle } from "../src/cli/selfUpdate.js";

/** Same signing scheme as scripts/sign-cli.mjs. */
function signBundle(bundle: Buffer) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sha256: crypto.createHash("sha256").update(bundle).digest("hex"),
    signatureB64: crypto.sign(null, bundle, privateKey).toString("base64"),
  };
}

describe("self-update bundle verification", () => {
  const bundle = Buffer.from("#!/usr/bin/env node\nconsole.log('agent');\n");

  it("accepts a bundle whose sha256 and signature both match", () => {
    const s = signBundle(bundle);
    expect(verifyBundle(bundle, s.sha256, s.signatureB64, s.publicKeyPem)).toBeNull();
  });

  it("accepts the shasum file format (hash, spaces, filename)", () => {
    const s = signBundle(bundle);
    // selfUpdate() passes only the first token, but verifyBundle also trims.
    expect(verifyBundle(bundle, ` ${s.sha256} `, s.signatureB64, s.publicKeyPem)).toBeNull();
  });

  it("rejects a tampered bundle even when the attacker fixes the sha256", () => {
    const s = signBundle(bundle);
    const tampered = Buffer.concat([bundle, Buffer.from("require('evil');\n")]);
    const fixedSha = crypto.createHash("sha256").update(tampered).digest("hex");
    expect(verifyBundle(tampered, fixedSha, s.signatureB64, s.publicKeyPem)).toMatch(/signature/);
  });

  it("rejects a bundle whose sha256 does not match", () => {
    const s = signBundle(bundle);
    expect(verifyBundle(bundle, "0".repeat(64), s.signatureB64, s.publicKeyPem)).toMatch(
      /sha256 mismatch/,
    );
  });

  it("rejects a signature made with a different key", () => {
    const s = signBundle(bundle);
    const other = signBundle(bundle);
    expect(verifyBundle(bundle, s.sha256, other.signatureB64, s.publicKeyPem)).toMatch(
      /signature/,
    );
  });

  it("rejects garbage signatures without throwing", () => {
    const s = signBundle(bundle);
    expect(verifyBundle(bundle, s.sha256, "not-base64!!", s.publicKeyPem)).toMatch(/signature/);
  });
});
