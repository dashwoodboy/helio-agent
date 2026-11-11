/**
 * Pairing client (OAuth device-flow style): ask the server for a user code,
 * let the user approve it in their logged-in browser, and poll until the
 * one-shot agent token arrives. No password ever passes through the agent.
 */
import { parseServerUrl } from "./serverUrl.js";

export interface PairingCodes {
  deviceCode: string;
  userCode: string;
  expiresInS: number;
  intervalS: number;
  /** The page the user opens to approve this agent. */
  verificationUrl: string;
}

export type PairingOutcome =
  | { status: "approved"; token: string; agentId: string }
  | { status: "denied" }
  | { status: "expired" };

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Server replied ${res.status} for ${new URL(url).pathname}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function startPairing(
  serverUrl: string,
  device: { name: string; platform: string },
): Promise<PairingCodes> {
  const { baseUrl } = parseServerUrl(serverUrl);
  const data = await postJson(`${baseUrl}/api/agent/pair/start`, device);
  const userCode = String(data.userCode);
  return {
    deviceCode: String(data.deviceCode),
    userCode,
    expiresInS: Number(data.expiresInS),
    intervalS: Number(data.intervalS) || 3,
    verificationUrl: `${baseUrl}/agent/link?code=${encodeURIComponent(userCode)}`,
  };
}

export async function pollPairing(
  serverUrl: string,
  deviceCode: string,
): Promise<{ status: "pending" } | PairingOutcome> {
  const { baseUrl } = parseServerUrl(serverUrl);
  const data = await postJson(`${baseUrl}/api/agent/pair/poll`, { deviceCode });
  if (data.status === "approved") {
    return { status: "approved", token: String(data.token), agentId: String(data.agentId) };
  }
  if (data.status === "denied") return { status: "denied" };
  if (data.status === "expired") return { status: "expired" };
  return { status: "pending" };
}

/** Poll until the user settles the code (or it expires). */
export async function waitForApproval(
  serverUrl: string,
  codes: PairingCodes,
  opts: { signal?: AbortSignal } = {},
): Promise<PairingOutcome> {
  const intervalMs = Math.max(1, codes.intervalS) * 1000;
  const deadline = Date.now() + codes.expiresInS * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { status: "expired" };
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const result = await pollPairing(serverUrl, codes.deviceCode);
      if (result.status !== "pending") return result;
    } catch {
      // Transient network error: keep polling until the code expires.
    }
  }
  return { status: "expired" };
}
