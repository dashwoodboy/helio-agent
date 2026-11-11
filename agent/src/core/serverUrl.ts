/**
 * Server URL policy — the security boundary for everything the agent sends.
 *
 * Only `https://` servers are accepted; plain `http://` is allowed solely for
 * loopback addresses (local development). Certificate verification is never
 * disabled anywhere in the agent. The agent token and all pairing traffic ride
 * on URLs derived here, so nothing can leave the machine unencrypted.
 */

export interface ServerEndpoints {
  /** Canonical origin (scheme + host + optional path prefix), no trailing slash. */
  baseUrl: string;
  /** WebSocket URL of the agent uplink (`wss://…/ws/agent`). */
  agentWsUrl: string;
  /** True when the URL is plain http on loopback (development only). */
  insecureLoopback: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export function parseServerUrl(input: string): ServerEndpoints {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the Helio server address");

  // Bare domains get https, never http.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That does not look like a valid server address");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only https:// server addresses are supported");
  }
  if (url.username || url.password) {
    throw new Error("Credentials in the server address are not allowed");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Plain http is only allowed for localhost — use https://");
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.protocol}//${url.host}${basePath}`;
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    baseUrl,
    agentWsUrl: `${wsProtocol}//${url.host}${basePath}/ws/agent`,
    insecureLoopback: url.protocol === "http:",
  };
}
