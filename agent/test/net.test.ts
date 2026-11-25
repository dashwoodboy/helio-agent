/**
 * Network layer: friendly error descriptions for the cause-chains Node
 * actually produces, and the preflight walking DNS → TCP/TLS → HTTP → WS
 * against real local servers.
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  describeHttpStatus,
  describeNetworkError,
  fetchWithTimeout,
  preflight,
} from "../src/core/net.js";

function err(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("describeNetworkError", () => {
  it("translates the common failure codes into actionable sentences", () => {
    expect(describeNetworkError(err("ENOTFOUND"))).toMatch(/DNS/);
    expect(describeNetworkError(err("ECONNREFUSED"))).toMatch(/refused/);
    expect(describeNetworkError(err("ETIMEDOUT"))).toMatch(/timed out/);
    expect(describeNetworkError(err("ECONNRESET"))).toMatch(/interrupted/);
    expect(describeNetworkError(err("EHOSTUNREACH"))).toMatch(/internet access/);
    expect(describeNetworkError(err("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toMatch(/[Aa]ntivirus/);
    expect(describeNetworkError(err("SELF_SIGNED_CERT_IN_CHAIN"))).toMatch(/HTTPS/);
  });

  it("unwraps the cause chain that undici's « fetch failed » hides", () => {
    // What a DNS failure from global fetch really looks like.
    const wrapped = new TypeError("fetch failed");
    (wrapped as { cause?: unknown }).cause = err("ENOTFOUND", "getaddrinfo ENOTFOUND nope.example");
    expect(describeNetworkError(wrapped)).toMatch(/DNS/);

    // Nested one level deeper (socket error inside a connect error).
    const outer = new TypeError("fetch failed");
    const mid = new Error("connect failed");
    (mid as { cause?: unknown }).cause = err("CERT_HAS_EXPIRED");
    (outer as { cause?: unknown }).cause = mid;
    expect(describeNetworkError(outer)).toMatch(/secure connection/i);
  });

  it("never surfaces a bare « fetch failed »", () => {
    const anonymous = new TypeError("fetch failed");
    const text = describeNetworkError(anonymous);
    expect(text).not.toBe("fetch failed");
    expect(text.length).toBeGreaterThan(20);
  });

  it("describes HTTP statuses the agent endpoints can hit", () => {
    expect(describeHttpStatus(403)).toMatch(/Cloudflare|blocked/);
    expect(describeHttpStatus(502)).toMatch(/gateway/i);
    expect(describeHttpStatus(429)).toMatch(/slow down/);
  });
});

describe("fetchWithTimeout", () => {
  it("aborts a server that never answers", async () => {
    const server = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 300 }),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("uses the injected fetch implementation", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const res = await fetchWithTimeout("http://example.test/x", {}, { fetchImpl: fake });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["http://example.test/x"]);
  });
});

describe("preflight", () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
  });

  /** Local server with a healthy API and a hub that 4401s unknown tokens. */
  async function healthyServer(): Promise<number> {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/system/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const wss = new WebSocketServer({ server, path: "/ws/agent" });
    wss.on("connection", (socket) => socket.close(4401, "unauthorized"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  it("passes all four steps against a healthy server", async () => {
    const port = await healthyServer();
    const steps = await preflight(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });
    expect(steps.map((s) => `${s.id}:${s.ok}`)).toEqual([
      "dns:true",
      "tls:true",
      "http:true",
      "websocket:true",
    ]);
  });

  it("stops at DNS for a name that doesn't exist", async () => {
    const steps = await preflight("https://does-not-exist.invalid", { timeoutMs: 3000 });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: "dns", ok: false });
    expect(steps[0].detail).toMatch(/DNS/);
  });

  it("stops at the connection step when nothing listens on the port", async () => {
    // Grab a port and close it again so nothing is listening there.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const steps = await preflight(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });
    expect(steps.at(-1)).toMatchObject({ id: "tls", ok: false });
    expect(steps.at(-1)!.detail).toMatch(/refused/);
  });

  it("reports an unhealthy HTTP answer without reaching the websocket step", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(502);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const steps = await preflight(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });
    expect(steps.at(-1)).toMatchObject({ id: "http", ok: false });
    expect(steps.at(-1)!.detail).toMatch(/gateway/i);
  });

  it("flags a server whose websocket upgrade is blocked", async () => {
    // Health answers, but the upgrade endpoint doesn't exist (a reverse
    // proxy that strips WebSockets behaves like this).
    const server = http.createServer((req, res) => {
      if (req.url === "/api/system/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const steps = await preflight(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });
    expect(steps.at(-1)).toMatchObject({ id: "websocket", ok: false });
  });
});
