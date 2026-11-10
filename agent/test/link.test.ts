/**
 * AgentLink against a fake hub: hello/ready, RPC relay to a fake stick
 * through the registry, token placement (header, never URL), dead-token
 * handling, and real TLS certificate verification.
 */
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import selfsigned from "selfsigned";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { AgentLink, AGENT_PROTOCOL_VERSION } from "../src/core/link.js";
import { StickRegistry } from "../src/core/sticks.js";
import { startFakeStick, type FakeStickHandle } from "./fakeStick.js";
import { REG_1P } from "../../backend/src/inverter/registers.js";

const SERIAL = 2755501234;
const TOKEN = "hat_" + "a".repeat(64);

interface FakeHub {
  port: number;
  /** Connections in arrival order: upgrade request + socket + received messages. */
  connections: { req: IncomingMessage; socket: ServerSocket; messages: Record<string, unknown>[] }[];
  waitConnection: (index?: number) => Promise<FakeHub["connections"][number]>;
  close: () => Promise<void>;
}

/** Minimal hub: answers hello with ready; collects everything else. */
function startFakeHub(server: http.Server | https.Server): Promise<FakeHub> {
  const wss = new WebSocketServer({ server, path: "/ws/agent", maxPayload: 64 * 1024 });
  const connections: FakeHub["connections"] = [];

  wss.on("connection", (socket, req) => {
    const conn = { req, socket, messages: [] as Record<string, unknown>[] };
    connections.push(conn);
    socket.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      conn.messages.push(msg);
      if (msg.type === "hello") {
        socket.send(JSON.stringify({ type: "ready", agentId: "agent-1", name: "Test agent" }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        connections,
        waitConnection: async (index = 0) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (connections[index]) return connections[index];
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error("timed out waiting for a hub connection");
        },
        close: () =>
          new Promise((resolve) => {
            for (const conn of connections) conn.socket.terminate();
            wss.close();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      });
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let stick: FakeStickHandle;
const links: AgentLink[] = [];
const hubs: FakeHub[] = [];
const registries: StickRegistry[] = [];

beforeAll(async () => {
  stick = await startFakeStick({ serial: SERIAL });
});

afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  for (const registry of registries.splice(0)) await registry.close();
});

afterAll(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  await stick?.stop();
});

/** Registry preloaded with the fake stick (as a discovery round would). */
function registryWithStick(): StickRegistry {
  const registry = new StickRegistry();
  registry.update([{ ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: SERIAL, port: stick.tcpPort }]);
  registries.push(registry);
  return registry;
}

function makeLink(serverUrl: string, registry: StickRegistry, extra: Partial<{ ca: string; log: (m: string) => void }> = {}): AgentLink {
  const link = new AgentLink({
    serverUrl,
    token: TOKEN,
    name: "Test agent",
    platform: "macos",
    version: "0.0.0-test",
    registry,
    ...extra,
  });
  links.push(link);
  return link;
}

describe("agent link", () => {
  it("sends hello + sticks, keeps the token in the Authorization header only", async () => {
    const hub = await startFakeHub(http.createServer());
    hubs.push(hub);
    const registry = registryWithStick();
    const link = makeLink(`http://127.0.0.1:${hub.port}`, registry);
    link.start();

    const conn = await hub.waitConnection();
    // Token travels in the header, never in the URL.
    expect(conn.req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(conn.req.url).not.toContain(TOKEN.slice(4, 24));

    await waitFor(() => link.status === "online", 5000, "link online");
    await waitFor(() => conn.messages.some((m) => m.type === "sticks"), 5000, "sticks report");

    const hello = conn.messages.find((m) => m.type === "hello")!;
    expect(hello).toMatchObject({ protocol: AGENT_PROTOCOL_VERSION, name: "Test agent" });
    const sticks = conn.messages.find((m) => m.type === "sticks")!;
    expect(sticks.sticks).toEqual([
      { serial: SERIAL, ip: "127.0.0.1", mac: "AABBCCDDEEFF", reachable: true },
    ]);
  });

  it("relays read and write RPCs to the stick and answers errors honestly", async () => {
    const hub = await startFakeHub(http.createServer());
    hubs.push(hub);
    const link = makeLink(`http://127.0.0.1:${hub.port}`, registryWithStick());
    link.start();
    const conn = await hub.waitConnection();
    await waitFor(() => link.status === "online", 5000, "link online");

    const rpc = (payload: Record<string, unknown>) => conn.socket.send(JSON.stringify(payload));
    const result = async (id: string) => {
      await waitFor(() => conn.messages.some((m) => m.type === "result" && m.id === id), 8000, `result ${id}`);
      return conn.messages.find((m) => m.type === "result" && m.id === id)!;
    };

    // Read one register (battery capacity: deterministic in the simulator bank).
    rpc({ type: "rpc", id: "r1", serial: SERIAL, op: "read", addr: REG_1P.batteryCapacityAh, quantity: 1 });
    const read = await result("r1");
    expect(read.ok).toBe(true);
    expect((read.values as number[])[0]).toBeGreaterThan(0);

    // Write one settings register and read it back through the stick.
    rpc({ type: "rpc", id: "w1", serial: SERIAL, op: "write1", addr: 230, value: 42 });
    expect((await result("w1")).ok).toBe(true);
    expect(stick.registers.get(230)).toBe(42);

    rpc({ type: "rpc", id: "r2", serial: SERIAL, op: "read", addr: 230, quantity: 1 });
    expect(((await result("r2")).values as number[])[0]).toBe(42);

    // Unknown serial → honest error, no crash.
    rpc({ type: "rpc", id: "bad", serial: 1, op: "read", addr: 0, quantity: 1 });
    const bad = await result("bad");
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/not visible/);
  });

  it("treats 4401/4403 as a dead token and stops reconnecting", async () => {
    const hub = await startFakeHub(http.createServer());
    hubs.push(hub);
    const link = makeLink(`http://127.0.0.1:${hub.port}`, new StickRegistry());
    link.start();
    const conn = await hub.waitConnection();
    await waitFor(() => link.status === "online", 5000, "link online");

    conn.socket.close(4403, "revoked");
    await waitFor(() => link.status === "unauthorized", 5000, "unauthorized status");
    // No new connection attempts follow.
    await new Promise((r) => setTimeout(r, 1500));
    expect(hub.connections).toHaveLength(1);
  });

  it("reconnects with backoff after a server restart-style close", async () => {
    const hub = await startFakeHub(http.createServer());
    hubs.push(hub);
    const link = makeLink(`http://127.0.0.1:${hub.port}`, new StickRegistry());
    link.start();
    const conn = await hub.waitConnection();
    await waitFor(() => link.status === "online", 5000, "link online");

    conn.socket.close(1001, "restarting");
    await waitFor(() => link.status === "offline", 5000, "offline status");
    const conn2 = await hub.waitConnection(1); // second connection = reconnect
    expect(conn2.req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await waitFor(() => link.status === "online", 5000, "back online");
  });
});

describe("TLS certificate verification", () => {
  it("refuses a server with an untrusted certificate, accepts it with the CA supplied", async () => {
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
      ],
    });
    const hub = await startFakeHub(https.createServer({ cert: pems.cert, key: pems.private }));
    hubs.push(hub);

    // Without the CA: certificate verification must fail (never disabled).
    const logs: string[] = [];
    const bad = makeLink(`https://localhost:${hub.port}`, new StickRegistry(), {
      log: (m) => logs.push(m),
    });
    bad.start();
    await waitFor(() => bad.status === "offline", 5000, "TLS failure");
    expect(hub.connections).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/self[- ]?signed|certificate/i);
    bad.stop();

    // With the CA added (private deployments): verification passes.
    const good = makeLink(`https://localhost:${hub.port}`, new StickRegistry(), { ca: pems.cert });
    good.start();
    await waitFor(() => good.status === "online", 5000, "TLS link online");
    expect(hub.connections).toHaveLength(1);
  });
});
