import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * In-memory pairing flow for the Helio Agent (OAuth device-flow style):
 *
 *   agent  → start()            → { deviceCode, userCode }
 *   website→ info(userCode)     → device details for the approval page
 *   website→ approve(userCode)  → caller creates the agent row, deposits the
 *                                 raw token here for one-shot delivery
 *   agent  → poll(deviceCode)   → "pending" | approval (token, once) | ...
 *
 * Codes expire after 10 minutes and are single use. The user code is short
 * (typed by a human); brute-forcing it is countered by the per-IP failure
 * lockout plus the HTTP rate limit, and by the code space itself (~10^12).
 */

const TTL_MS = 10 * 60000;
/** Unambiguous alphabet (no 0/O, 1/I/L, etc.). */
const ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
const USER_CODE_LEN = 8;
/** Failed user-code lookups allowed per IP per TTL window. */
const MAX_LOOKUP_FAILURES = 10;

export interface PairingDeviceInfo {
  name: string;
  platform: string;
  /** IP the pairing started from, shown on the approval page. */
  ip: string;
  createdAt: Date;
  /**
   * Agent id this device paired as before (re-pairing after a lost token).
   * Honoured at approval only when that agent belongs to the approving user:
   * the token is rotated and the id kept, so environments stay linked.
   */
  previousAgentId: string | null;
}

interface PendingPairing extends PairingDeviceInfo {
  deviceCodeHash: Buffer;
  userCode: string;
  expiresAt: number;
  /** Set on approval; cleared after the first successful poll. */
  approval: { token: string; agentId: string } | null;
  denied: boolean;
  /** True once approve/deny consumed the code (single use). */
  settled: boolean;
}

export type PollResult =
  | { status: "pending" }
  | { status: "approved"; token: string; agentId: string }
  | { status: "denied" }
  | { status: "expired" };

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 256-bit agent credential, generated at approval time. */
export function generateAgentToken(): string {
  return `hat_${randomBytes(32).toString("hex")}`;
}

function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercase, strip separators/whitespace so "abcd-efgh" matches "ABCDEFGH". */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export class PairingStore {
  private readonly pending = new Map<string, PendingPairing>(); // key: normalized user code
  private readonly lookupFailures = new Map<string, { count: number; resetAt: number }>();

  /** Begin pairing; returns the codes the agent shows/polls with. */
  start(info: { name: string; platform: string; ip: string; previousAgentId?: string | null }): {
    deviceCode: string;
    userCode: string;
    expiresInS: number;
    intervalS: number;
  } {
    this.sweep();
    const deviceCode = randomBytes(32).toString("hex");
    let raw: string;
    do {
      raw = Array.from(randomBytes(USER_CODE_LEN), (b) => ALPHABET[b % ALPHABET.length]).join("");
    } while (this.pending.has(raw));
    this.pending.set(raw, {
      name: info.name.slice(0, 60) || "Unnamed device",
      platform: info.platform.slice(0, 20),
      ip: info.ip,
      createdAt: new Date(),
      previousAgentId: info.previousAgentId ?? null,
      deviceCodeHash: createHash("sha256").update(deviceCode, "utf8").digest(),
      userCode: formatUserCode(raw),
      expiresAt: Date.now() + TTL_MS,
      approval: null,
      denied: false,
      settled: false,
    });
    return {
      deviceCode,
      userCode: formatUserCode(raw),
      expiresInS: TTL_MS / 1000,
      intervalS: 3,
    };
  }

  /**
   * Device details for the approval page. Unknown/expired/settled codes count
   * as a failed lookup for the caller's IP (anti-bruteforce lockout).
   */
  info(userCode: string, callerIp: string): PairingDeviceInfo | null {
    this.sweep();
    if (this.ipLocked(callerIp)) return null;
    const entry = this.pending.get(normalizeUserCode(userCode));
    if (!entry || entry.settled || Date.now() > entry.expiresAt) {
      this.recordFailure(callerIp);
      return null;
    }
    return {
      name: entry.name,
      platform: entry.platform,
      ip: entry.ip,
      createdAt: entry.createdAt,
      previousAgentId: entry.previousAgentId,
    };
  }

  /**
   * Mark the code approved and deposit the raw token for the agent's next
   * poll. The caller creates the agents DB row first. Single use.
   */
  approve(userCode: string, callerIp: string, approval: { token: string; agentId: string }): boolean {
    this.sweep();
    if (this.ipLocked(callerIp)) return false;
    const entry = this.pending.get(normalizeUserCode(userCode));
    if (!entry || entry.settled || Date.now() > entry.expiresAt) {
      this.recordFailure(callerIp);
      return false;
    }
    entry.settled = true;
    entry.approval = approval;
    return true;
  }

  deny(userCode: string, callerIp: string): boolean {
    this.sweep();
    if (this.ipLocked(callerIp)) return false;
    const entry = this.pending.get(normalizeUserCode(userCode));
    if (!entry || entry.settled || Date.now() > entry.expiresAt) {
      this.recordFailure(callerIp);
      return false;
    }
    entry.settled = true;
    entry.denied = true;
    return true;
  }

  /** The agent polls with its (long, secret) device code. */
  poll(deviceCode: string): PollResult {
    this.sweep();
    const hash = createHash("sha256").update(deviceCode, "utf8").digest();
    for (const [key, entry] of this.pending) {
      if (entry.deviceCodeHash.length !== hash.length) continue;
      if (!timingSafeEqual(entry.deviceCodeHash, hash)) continue;
      if (Date.now() > entry.expiresAt) {
        this.pending.delete(key);
        return { status: "expired" };
      }
      if (entry.denied) {
        this.pending.delete(key);
        return { status: "denied" };
      }
      if (entry.approval) {
        // One-shot delivery: the raw token leaves memory here.
        const approval = entry.approval;
        this.pending.delete(key);
        return { status: "approved", ...approval };
      }
      return { status: "pending" };
    }
    return { status: "expired" };
  }

  private ipLocked(ip: string): boolean {
    const f = this.lookupFailures.get(ip);
    return !!f && f.count >= MAX_LOOKUP_FAILURES && Date.now() < f.resetAt;
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const f = this.lookupFailures.get(ip);
    if (!f || now > f.resetAt) {
      this.lookupFailures.set(ip, { count: 1, resetAt: now + TTL_MS });
    } else {
      f.count++;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      // Keep settled entries until expiry so poll() can still deliver/deny.
      if (now > entry.expiresAt) this.pending.delete(key);
    }
    for (const [ip, f] of this.lookupFailures) {
      if (now > f.resetAt) this.lookupFailures.delete(ip);
    }
  }
}
