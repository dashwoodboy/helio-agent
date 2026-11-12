/**
 * Network layer for everything the agent does over HTTP(S).
 *
 * Three jobs:
 *  - `describeNetworkError` turns Node's nested cause-chain errors ("fetch
 *    failed") into one honest sentence a non-technical user can act on.
 *  - `fetchWithTimeout` is fetch with a deadline and an injectable
 *    implementation (the Electron shell installs Chromium's `net.fetch`,
 *    which uses the OS certificate store and proxy settings).
 *  - `preflight` walks the path to the server step by step (DNS → TLS →
 *    HTTP → WebSocket upgrade) and reports which step broke, so "can't
 *    connect" becomes "your antivirus intercepts HTTPS" or "DNS is down".
 */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import WebSocket from "ws";
import { isLoopbackHost, parseServerUrl } from "./serverUrl.js";

export type FetchImpl = typeof fetch;

/**
 * Process-wide fetch used by pairing, update checks and preflight. The
 * Electron main process replaces it with `net.fetch` (Chromium stack: OS
 * trust store + OS proxy). Tests inject fakes per call instead.
 */
let defaultFetch: FetchImpl = (...args) => fetch(...args);

export function setDefaultFetch(impl: FetchImpl): void {
  defaultFetch = impl;
}

export function getDefaultFetch(): FetchImpl {
  return defaultFetch;
}

const DEFAULT_TIMEOUT_MS = 15000;

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/** fetch with a hard deadline; throws a TimeoutError-shaped error on expiry. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: FetchOptions = {},
): Promise<Response> {
  const impl = opts.fetchImpl ?? defaultFetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return impl(url, { ...init, signal });
}

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

/** Collect `code`, `name` and `message` through the err.cause chain. */
function unwrap(err: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.name === "string") codes.push(e.name);
    if (typeof e.message === "string" && e.message) messages.push(e.message);
    current = e.cause;
  }
  return { codes, messages };
}

/**
 * One human sentence for a network failure. Never returns Node's raw
 * "fetch failed"; worst case it quotes the deepest message it found.
 */
export function describeNetworkError(err: unknown): string {
  const { codes, messages } = unwrap(err);
  const has = (...wanted: string[]) => wanted.some((w) => codes.includes(w));

  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_FAIL")) {
    return "The server address could not be found (DNS). Check the address and your internet connection.";
  }
  if (codes.some((c) => CERT_CODES.has(c))) {
    return (
      "The secure connection could not be verified. Antivirus software or a company " +
      "proxy that inspects HTTPS traffic often causes this — try disabling HTTPS " +
      "scanning for this app, or add your network's CA certificate."
    );
  }
  if (has("ECONNREFUSED")) {
    return "The server refused the connection. The address may be wrong, or the service may be down.";
  }
  if (has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError", "ETIME", "ERR_SOCKET_CONNECTION_TIMEOUT")) {
    return "The connection timed out. A firewall, VPN or unstable network may be blocking it.";
  }
  if (has("AbortError")) {
    return "The request was cancelled before the server answered (timeout).";
  }
  if (has("ECONNRESET", "EPIPE", "UND_ERR_SOCKET")) {
    return "The connection was interrupted mid-way. A proxy, VPN or antivirus may be cutting it off.";
  }
  if (has("EHOSTUNREACH", "ENETUNREACH", "ENETDOWN")) {
    return "The server could not be reached. Check that this machine has internet access.";
  }
  if (has("EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER")) {
    return "The secure (TLS) handshake failed. The address may point to a non-HTTPS service, or a proxy is interfering.";
  }
  if (has("ERR_PROXY_CONNECTION_FAILED", "EPROXY")) {
    return "The configured proxy could not be reached. Check the system proxy settings.";
  }
  // No recognised code: quote the most specific message we have.
  const detail = messages.at(-1) ?? "";
  return detail && detail !== "fetch failed"
    ? `Network error: ${detail}`
    : "Network error: the server could not be reached.";
}

/** One sentence for an HTTP error status on agent endpoints. */
export function describeHttpStatus(status: number): string {
  if (status === 403) {
    return "The server (or its protection service, e.g. Cloudflare) blocked the request (403). A VPN exit or shared IP may be flagged.";
  }
  if (status === 407) {
    return "The network requires a proxy sign-in (407). Configure the proxy credentials in the OS.";
  }
  if (status === 429) {
    return "The server asked us to slow down (429). Wait a minute and try again.";
  }
  if (status === 502 || status === 504) {
    return `The server's gateway could not reach it (${status}) — usually temporary; try again shortly.`;
  }
  if (status === 426) {
    return "The server requires a secure (HTTPS) connection (426).";
  }
  return `The server replied with HTTP ${status}.`;
}

// ---------------------------------------------------------------- preflight

export interface PreflightStep {
  id: "dns" | "tls" | "http" | "websocket";
  label: string;
  ok: boolean;
  /** Human detail: what was found, or what broke and what to do. */
  detail: string;
}

export interface PreflightOptions {
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /** Extra trusted CA (PEM) for private deployments. */
  ca?: string | Buffer;
}

/**
 * Walk the path to the server and report each step. Steps after the first
 * failure are skipped (their result would only repeat the same cause).
 * The WebSocket step uses a throwaway invalid token: a 4401 close proves the
 * whole uplink path (TLS, proxy, upgrade) works end to end.
 */
export async function preflight(
  serverUrl: string,
  opts: PreflightOptions = {},
): Promise<PreflightStep[]> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const steps: PreflightStep[] = [];
  let endpoints;
  try {
    endpoints = parseServerUrl(serverUrl);
  } catch (err) {
    return [
      { id: "dns", label: "Server address", ok: false, detail: (err as Error).message },
    ];
  }
  const url = new URL(endpoints.baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

  // 1. DNS ------------------------------------------------------------
  let addresses: string[] = [];
  if (net.isIP(host) || isLoopbackHost(host)) {
    addresses = [host];
    steps.push({ id: "dns", label: "Find the server (DNS)", ok: true, detail: host });
  } else {
    try {
      const found = await dns.lookup(host, { all: true });
      addresses = found.map((a) => a.address);
      steps.push({
        id: "dns",
        label: "Find the server (DNS)",
        ok: true,
        detail: `${host} → ${addresses.slice(0, 3).join(", ")}`,
      });
    } catch (err) {
      steps.push({
        id: "dns",
        label: "Find the server (DNS)",
        ok: false,
        detail: describeNetworkError(err),
      });
      return steps;
    }
  }

  // 2. TCP/TLS ---------------------------------------------------------
  const secure = url.protocol === "https:";
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = secure
        ? tls.connect({
            host,
            port,
            servername: host,
            ...(opts.ca ? { ca: opts.ca } : {}),
          })
        : net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      const done = (err?: Error) => {
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.once(secure ? "secureConnect" : "connect", () => done());
      socket.once("error", (err) => done(err));
    });
    steps.push({
      id: "tls",
      label: secure ? "Secure connection (TLS)" : "Connection (TCP)",
      ok: true,
      detail: `${host}:${port}`,
    });
  } catch (err) {
    steps.push({
      id: "tls",
      label: secure ? "Secure connection (TLS)" : "Connection (TCP)",
      ok: false,
      detail: describeNetworkError(err),
    });
    return steps;
  }

  // 3. HTTP ------------------------------------------------------------
  try {
    const res = await fetchWithTimeout(
      `${endpoints.baseUrl}/api/system/health`,
      { headers: { accept: "application/json" } },
      { timeoutMs, fetchImpl: opts.fetchImpl },
    );
    if (res.ok) {
      steps.push({ id: "http", label: "Helio server answers", ok: true, detail: "healthy" });
    } else {
      steps.push({
        id: "http",
        label: "Helio server answers",
        ok: false,
        detail: describeHttpStatus(res.status),
      });
      return steps;
    }
  } catch (err) {
    steps.push({
      id: "http",
      label: "Helio server answers",
      ok: false,
      detail: describeNetworkError(err),
    });
    return steps;
  }

  // 4. WebSocket upgrade -------------------------------------------------
  try {
    const result = await new Promise<{ code: number }>((resolve, reject) => {
      const ws = new WebSocket(endpoints.agentWsUrl, {
        headers: { authorization: "Bearer hat_preflight" },
        ...(opts.ca ? { ca: opts.ca } : {}),
        handshakeTimeout: timeoutMs,
        maxPayload: 64 * 1024,
      });
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", (err) => {
        // A close event may still follow with a code; give it a tick.
        setTimeout(() => reject(err), 50);
      });
    });
    if (result.code === 4401) {
      // Exactly what a wrong token should get: the uplink path works.
      steps.push({ id: "websocket", label: "Agent uplink (WebSocket)", ok: true, detail: "ready for the agent connection" });
    } else {
      steps.push({
        id: "websocket",
        label: "Agent uplink (WebSocket)",
        ok: false,
        detail: `The server closed the test connection with code ${result.code}. A proxy may be blocking WebSockets.`,
      });
    }
  } catch (err) {
    steps.push({
      id: "websocket",
      label: "Agent uplink (WebSocket)",
      ok: false,
      detail: describeNetworkError(err),
    });
  }
  return steps;
}
