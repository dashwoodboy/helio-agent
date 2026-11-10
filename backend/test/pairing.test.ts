/**
 * PairingStore hardening: expiry, single use, deny, per-IP lockout, code
 * normalization, and the token helpers. Pure in-memory — no database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateAgentToken,
  hashAgentToken,
  normalizeUserCode,
  PairingStore,
} from "../src/agent/pairing.js";

const IP = "203.0.113.5";
const APPROVAL = { token: "hat_test", agentId: "00000000-0000-0000-0000-000000000001" };

afterEach(() => {
  vi.useRealTimers();
});

describe("pairing store", () => {
  it("codes are well formed and polling starts pending", () => {
    const store = new PairingStore();
    const { deviceCode, userCode, expiresInS } = store.start({ name: "PC", platform: "linux", ip: IP });
    expect(deviceCode).toMatch(/^[0-9a-f]{64}$/);
    // Unambiguous alphabet: no 0/O/1/I/L.
    expect(userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{4}-[BCDFGHJKMNPQRSTVWXYZ2-9]{4}$/);
    expect(expiresInS).toBe(600);
    expect(store.poll(deviceCode)).toEqual({ status: "pending" });
    expect(store.info(userCode, IP)).toMatchObject({ name: "PC", platform: "linux" });
  });

  it("codes expire after 10 minutes", () => {
    vi.useFakeTimers();
    const store = new PairingStore();
    const { deviceCode, userCode } = store.start({ name: "PC", platform: "linux", ip: IP });

    vi.advanceTimersByTime(10 * 60000 + 1000);
    expect(store.info(userCode, IP)).toBeNull();
    expect(store.approve(userCode, IP, APPROVAL)).toBe(false);
    expect(store.poll(deviceCode)).toEqual({ status: "expired" });
  });

  it("approval is single use and the token is delivered exactly once", () => {
    const store = new PairingStore();
    const { deviceCode, userCode } = store.start({ name: "PC", platform: "macos", ip: IP });

    expect(store.approve(userCode, IP, APPROVAL)).toBe(true);
    // Settled: no second approve, deny, or info.
    expect(store.approve(userCode, IP, APPROVAL)).toBe(false);
    expect(store.deny(userCode, IP)).toBe(false);
    expect(store.info(userCode, IP)).toBeNull();

    expect(store.poll(deviceCode)).toEqual({ status: "approved", ...APPROVAL });
    // One-shot: the raw token is purged with the first delivery.
    expect(store.poll(deviceCode)).toEqual({ status: "expired" });
  });

  it("denied codes settle and report denied to the agent once", () => {
    const store = new PairingStore();
    const { deviceCode, userCode } = store.start({ name: "PC", platform: "windows", ip: IP });

    expect(store.deny(userCode, IP)).toBe(true);
    expect(store.approve(userCode, IP, APPROVAL)).toBe(false);
    expect(store.poll(deviceCode)).toEqual({ status: "denied" });
    expect(store.poll(deviceCode)).toEqual({ status: "expired" });
  });

  it("locks an IP out after repeated failed lookups", () => {
    const store = new PairingStore();
    const { userCode } = store.start({ name: "PC", platform: "linux", ip: IP });

    const attacker = "198.51.100.9";
    for (let i = 0; i < 10; i++) {
      expect(store.info("ZZZZ-ZZZZ", attacker)).toBeNull();
    }
    // Even the valid code is refused for the locked IP...
    expect(store.info(userCode, attacker)).toBeNull();
    expect(store.approve(userCode, attacker, APPROVAL)).toBe(false);
    // ...while other callers are unaffected.
    expect(store.info(userCode, IP)).not.toBeNull();
  });

  it("user codes match regardless of case and separators", () => {
    const store = new PairingStore();
    const { userCode } = store.start({ name: "PC", platform: "linux", ip: IP });
    const sloppy = userCode.toLowerCase().replace("-", " ");
    expect(normalizeUserCode(sloppy)).toBe(userCode.replace("-", ""));
    expect(store.info(sloppy, IP)).not.toBeNull();
  });

  it("agent tokens are 256-bit and hash deterministically", () => {
    const token = generateAgentToken();
    expect(token).toMatch(/^hat_[0-9a-f]{64}$/);
    expect(generateAgentToken()).not.toBe(token);
    expect(hashAgentToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token)).toBe(hashAgentToken(token));
    expect(hashAgentToken(token)).not.toContain(token.slice(4, 20));
  });
});
