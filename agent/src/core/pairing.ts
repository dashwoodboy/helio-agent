/**
 * Pairing client (OAuth device-flow style): ask the server for a user code,
 * let the user approve it in their logged-in browser, and poll until the
 * one-shot agent token arrives. No password ever passes through the agent.
 */
import { describeHttpStatus, describeNetworkError, fetchWithTimeout, type FetchOptions } from "./net.js";
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

async function postJson(
  url: string,
  body: unknown,
  opts: FetchOptions = {},
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      opts,
    );
  } catch (err) {
    // "fetch failed" helps nobody; say what actually broke.
    throw new Error(describeNetworkError(err));
  }
  if (!res.ok) {
    // Surface the server's own error text when it sent one (e.g. the agent
    // limit message), else a friendly description of the status.
    const serverError = await res
      .json()
      .then((data) => (data as { error?: unknown }).error)
      .catch(() => null);
    throw new Error(
      typeof serverError === "string" && serverError ? serverError : describeHttpStatus(res.status),
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function startPairing(
  serverUrl: string,
  device: { name: string; platform: string; previousAgentId?: string | null },
  opts: FetchOptions = {},
): Promise<PairingCodes> {
  const { baseUrl } = parseServerUrl(serverUrl);
  const data = await postJson(
    `${baseUrl}/api/agent/pair/start`,
    {
      name: device.name,
      platform: device.platform,
      // Re-pairing: ask the server to keep our old identity (and the
      // environments linked to it) instead of minting a new agent.
      ...(device.previousAgentId ? { previousAgentId: device.previousAgentId } : {}),
    },
    opts,
  );
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
  opts: FetchOptions = {},
): Promise<{ status: "pending" } | PairingOutcome> {
  const { baseUrl } = parseServerUrl(serverUrl);
  const data = await postJson(`${baseUrl}/api/agent/pair/poll`, { deviceCode }, opts);
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
  opts: { signal?: AbortSignal } & FetchOptions = {},
): Promise<PairingOutcome> {
  const intervalMs = Math.max(1, codes.intervalS) * 1000;
  const deadline = Date.now() + codes.expiresInS * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { status: "expired" };
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const result = await pollPairing(serverUrl, codes.deviceCode, opts);
      if (result.status !== "pending") return result;
    } catch {
      // Transient network error: keep polling until the code expires.
    }
  }
  return { status: "expired" };
}
