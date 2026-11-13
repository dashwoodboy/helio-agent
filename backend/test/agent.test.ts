/**
 * Helio Agent backend: pairing (device flow), the /ws/agent hub, RPC relay
 * to a fake agent answering from simulated registers, and the environment
 * lifecycle for agent-sourced sticks.
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to the
 * dev container on :55432). The test database is recreated each run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";

import { config } from "../src/config.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { StaticVerifier, type AuthUser } from "../src/auth/verifier.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { hashAgentToken } from "../src/agent/pairing.js";
import {
  AGENT_CLOSE_PROTOCOL,
  AGENT_CLOSE_REPLACED,
  AGENT_CLOSE_REVOKED,
  AGENT_CLOSE_UNAUTHORIZED,
  AGENT_PROTOCOL_VERSION,
} from "../src/agent/hub.js";
import { SimulatedInverter } from "../src/inverter/simulator.js";
import { defaultSimulatedRegisters } from "../src/inverter/control.js";
import { registersFrom } from "../scripts/fake-logger.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_agent";

const USERS: Record<string, AuthUser> = {
  "token-alice": { uid: "uid-alice", email: "alice@test.dev", emailVerified: true, displayName: "Alice" },
  "token-bob": { uid: "uid-bob", email: "bob@test.dev", emailVerified: true, displayName: "Bob" },
};

const SERIAL = 2712345678;

let server: BuiltServer;
let db: Db;
let pool: pg.Pool;
let wsPort: number;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A fake Helio Agent: speaks protocol v1 over /ws/agent and answers RPCs
 * from the same simulated 1-phase register model as scripts/fake-logger.ts
 * (live registers from the simulator, writable settings from a bank).
 */
class FakeAgent {
  ws!: WebSocket;
  readonly bank = defaultSimulatedRegisters();
  readonly closeCode: Promise<number>;
  private resolveClose!: (code: number) => void;
  private readonly messages: Record<string, unknown>[] = [];
  private readonly simulator = new SimulatedInverter({ kwp: 5.5, batteryCapacityKwh: 16 });
  private readonly simConfig = {
    phases: 1 as const,
    hasBattery: true,
    pvStrings: 2 as const,
    hasGenerator: false,
  };

  constructor() {
    this.closeCode = new Promise((resolve) => (this.resolveClose = resolve));
  }

  connect(token: string, opts: { autoPong?: boolean } = {}): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/agent`, {
      headers: { authorization: `Bearer ${token}` },
      autoPong: opts.autoPong ?? true,
    });
    this.ws.on("close", (code) => this.resolveClose(code));
    this.ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.messages.push(msg);
      if (msg.type === "rpc") void this.answerRpc(msg);
    });
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.send({
      type: "hello",
      protocol: AGENT_PROTOCOL_VERSION,
      version: "0.0.0-test",
      platform: "macos",
      name: "Test agent",
      ...overrides,
    });
  }

  reportStick(serial: number, reachable = true): void {
    this.send({
      type: "sticks",
      sticks: [{ serial, ip: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff", reachable }],
    });
  }

  async waitMessage(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    await waitFor(() => this.messages.some((m) => m.type === type), timeoutMs, `agent "${type}" message`);
    return this.messages.find((m) => m.type === type)!;
  }

  close(): void {
    this.ws?.close();
  }

  private async answerRpc(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string;
    const addr = msg.addr as number;
    if (msg.op === "read") {
      const quantity = msg.quantity as number;
      const live = registersFrom(await this.simulator.readFull(this.simConfig));
      const lookup = (a: number) => live.get(a) ?? this.bank.get(a);
      const known = [...Array(quantity).keys()].some((i) => lookup(addr + i) !== undefined);
      if (!known) {
        this.send({ type: "result", id, ok: false, error: "illegal data address" });
        return;
      }
      const values = [...Array(quantity).keys()].map((i) => lookup(addr + i) ?? 0);
      this.send({ type: "result", id, ok: true, values });
    } else if (msg.op === "write1") {
      this.bank.set(addr, msg.value as number);
      this.send({ type: "result", id, ok: true });
    } else if (msg.op === "writeN") {
      (msg.values as number[]).forEach((v, i) => this.bank.set(addr + i, v));
      this.send({ type: "result", id, ok: true });
    }
  }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const created = createDb(ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`));
  db = created.db;
  pool = created.pool;
  await runMigrations(db, 1);

  server = await buildServer({
    db,
    verifier: new StaticVerifier(new Map(Object.entries(USERS))),
    withGateway: false,
    pollOpts: { pollIntervalMs: 500, fullPollIntervalMs: 5000 },
    // Fast heartbeat so the missing-pong test completes in under a second.
    agentPingIntervalMs: 250,
    logLevel: "silent",
  });
  await server.app.ready();
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  wsPort = (server.app.server.address() as AddressInfo).port;
}, 60000);

afterAll(async () => {
  await server?.hub.closeAll();
  await server?.manager.shutdown();
  await server?.app.close();
  await pool?.end();
});

// Shared across the suites below (vitest runs one file serially).
let agentToken: string;
let agentId: string;

describe("agent pairing (device flow)", () => {
  it("pairs an agent end to end and stores only the token hash", async () => {
    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "Office Mac", platform: "macos" },
    });
    expect(start.statusCode).toBe(200);
    const { deviceCode, userCode, expiresInS, intervalS } = start.json();
    expect(deviceCode).toHaveLength(64);
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresInS).toBe(600);
    expect(intervalS).toBeGreaterThan(0);

    // Nothing approved yet.
    const pending = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(pending.json()).toEqual({ status: "pending" });

    // The approval page requires a signed-in user.
    const anon = await server.app.inject({ url: `/api/agent/pair/${userCode}` });
    expect(anon.statusCode).toBe(401);

    const info = await server.app.inject({
      url: `/api/agent/pair/${userCode}`,
      headers: auth("token-alice"),
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ name: "Office Mac", platform: "macos" });

    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${userCode}/approve`,
      headers: auth("token-alice"),
    });
    expect(approve.statusCode).toBe(200);
    agentId = approve.json().agentId;

    // The token is delivered to the agent exactly once.
    const approved = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(approved.json()).toMatchObject({ status: "approved", agentId });
    agentToken = approved.json().token;
    expect(agentToken).toMatch(/^hat_[0-9a-f]{64}$/);

    const again = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(again.json()).toEqual({ status: "expired" });

    // Server-side storage is the SHA-256 hash, never the raw token.
    const { rows } = await pool.query(`SELECT token_hash FROM agents WHERE id = $1`, [agentId]);
    expect(rows[0].token_hash).toBe(hashAgentToken(agentToken));
    expect(rows[0].token_hash).not.toContain(agentToken.slice(4, 20));

    // The agent is listed for its owner, offline for now.
    const list = await server.app.inject({ url: "/api/agents", headers: auth("token-alice") });
    expect(list.json()).toMatchObject([{ id: agentId, name: "Office Mac", online: false, sticks: [] }]);

    // ...and invisible to everyone else.
    const other = await server.app.inject({ url: "/api/agents", headers: auth("token-bob") });
    expect(other.json()).toEqual([]);
  });

  it("denied codes report denied to the polling agent", async () => {
    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "Evil box", platform: "linux" },
    });
    const { deviceCode, userCode } = start.json();

    const deny = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${userCode}/deny`,
      headers: auth("token-alice"),
    });
    expect(deny.statusCode).toBe(200);

    const polled = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(polled.json()).toEqual({ status: "denied" });
  });

  it("unknown user codes 404 and unknown device codes read as expired", async () => {
    const info = await server.app.inject({
      url: "/api/agent/pair/XXXX-XXXX",
      headers: auth("token-alice"),
    });
    expect(info.statusCode).toBe(404);

    const polled = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode: "f".repeat(64) },
    });
    expect(polled.json()).toEqual({ status: "expired" });
  });
});

describe("agent hub (/ws/agent)", () => {
  it("rejects unknown tokens", async () => {
    const agent = new FakeAgent();
    await agent.connect("hat_" + "0".repeat(64));
    expect(await agent.closeCode).toBe(AGENT_CLOSE_UNAUTHORIZED);
  });

  it("drops sessions that skip the hello", async () => {
    const agent = new FakeAgent();
    await agent.connect(agentToken);
    agent.reportStick(SERIAL);
    expect(await agent.closeCode).toBe(AGENT_CLOSE_PROTOCOL);
  });

  it("drops sessions with a mismatched protocol version", async () => {
    const agent = new FakeAgent();
    await agent.connect(agentToken);
    agent.hello({ protocol: AGENT_PROTOCOL_VERSION + 1 });
    expect(await agent.closeCode).toBe(AGENT_CLOSE_PROTOCOL);
  });

  it("connects, reports sticks, probes, and feeds an environment", async () => {
    const agent = new FakeAgent();
    await agent.connect(agentToken);
    agent.hello();
    const ready = await agent.waitMessage("ready");
    expect(ready).toMatchObject({ agentId });

    agent.reportStick(SERIAL);
    await waitFor(() => server.hub.hasStick(agentId, SERIAL), 5000, "stick report");

    const list = await server.app.inject({ url: "/api/agents", headers: auth("token-alice") });
    expect(list.json()[0]).toMatchObject({
      online: true,
      sticks: [{ serial: SERIAL, ip: "192.168.1.50", reachable: true }],
    });

    // Probe the stick through the agent: detect + one live sample over RPC.
    const probe = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/test`,
      headers: auth("token-alice"),
      payload: { serial: SERIAL },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
    expect(probe.json().config).toMatchObject({ phases: 1, hasBattery: true });
    expect(probe.json().sample.soc).toBeGreaterThanOrEqual(0);

    // Claim the stick with an agent-sourced environment: it starts polling.
    const create = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-alice"),
      payload: {
        name: "Agent env",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "agent",
        agentId,
        loggerSerial: SERIAL,
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ sourceType: "agent", agentId, loggerSerial: SERIAL });
    const envId = create.json().id as string;

    await waitFor(
      async () => (await server.manager.get(envId))?.liveState.current !== null,
      30000,
      "live snapshot through the agent",
    );
    const rt = (await server.manager.get(envId))!;
    expect(rt.inverterConfig.phases).toBe(1);
    expect(rt.liveState.current!.soc).toBeGreaterThanOrEqual(0);

    // Connectivity is reported through the hub for agent environments.
    const logger = await server.app.inject({
      url: `/api/environments/${envId}/logger`,
      headers: auth("token-alice"),
    });
    expect(logger.json()).toMatchObject({ serial: SERIAL, connected: true });

    // The serial stays single-claim across source types.
    const dup = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-alice"),
      payload: {
        name: "Dup env",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "agent",
        agentId,
        loggerSerial: SERIAL,
      },
    });
    expect(dup.statusCode).toBe(409);

    // Someone else's (or a made-up) agent id is rejected.
    const foreign = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth("token-bob"),
      payload: {
        name: "Bob env",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "agent",
        agentId,
        loggerSerial: SERIAL + 1,
      },
    });
    expect(foreign.statusCode).toBe(404);

    agent.close();
    await agent.closeCode;
    // The runtime detaches when the agent goes away.
    await waitFor(() => !server.hub.isOnline(agentId), 5000, "agent to go offline");
    const offline = await server.app.inject({
      url: `/api/environments/${envId}/logger`,
      headers: auth("token-alice"),
    });
    expect(offline.json()).toMatchObject({ connected: false });
  }, 60000);

  it("revoking an agent kicks the live socket and kills the token", async () => {
    const agent = new FakeAgent();
    await agent.connect(agentToken);
    agent.hello();
    await agent.waitMessage("ready");

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}`,
      headers: auth("token-alice"),
    });
    expect(del.statusCode).toBe(200);
    expect(await agent.closeCode).toBe(AGENT_CLOSE_REVOKED);

    // The credential is dead for reconnects too.
    const again = new FakeAgent();
    await again.connect(agentToken);
    expect(await again.closeCode).toBe(AGENT_CLOSE_UNAUTHORIZED);

    const list = await server.app.inject({ url: "/api/agents", headers: auth("token-alice") });
    expect(list.json()).toEqual([]);
  });
});

/** Each pairAgent call gets its own source IP so the per-IP rate limit on
 * pair/start (10/min) never trips across this file's many pairings. */
let pairIpCounter = 0;

/** Mint a fresh paired agent via the real pairing endpoints. */
async function pairAgent(name: string, userToken = "token-alice"): Promise<{ token: string; id: string }> {
  const remoteAddress = `10.99.0.${++pairIpCounter}`;
  const start = await server.app.inject({
    method: "POST",
    url: "/api/agent/pair/start",
    payload: { name, platform: "linux" },
    remoteAddress,
  });
  expect(start.statusCode).toBe(200);
  const { deviceCode, userCode } = start.json();
  const approve = await server.app.inject({
    method: "POST",
    url: `/api/agent/pair/${userCode}/approve`,
    headers: auth(userToken),
  });
  expect(approve.statusCode).toBe(200);
  const polled = await server.app.inject({
    method: "POST",
    url: "/api/agent/pair/poll",
    payload: { deviceCode },
  });
  expect(polled.json().status).toBe("approved");
  return { token: polled.json().token, id: polled.json().agentId };
}

/** Create an agent-sourced environment for a reported stick; returns env id. */
async function createAgentEnv(userToken: string, agentId: string, serial: number): Promise<string> {
  const create = await server.app.inject({
    method: "POST",
    url: "/api/environments",
    headers: auth(userToken),
    payload: {
      name: `Env ${serial}`,
      timezone: "Europe/Lisbon",
      lat: 38.72,
      lon: -9.14,
      sourceType: "agent",
      agentId,
      loggerSerial: serial,
    },
  });
  expect(create.statusCode).toBe(201);
  return create.json().id as string;
}

describe("session replacement and reconciliation", () => {
  // Bob's agents, so Alice's per-user limit test below stays unaffected.
  const SERIAL_RACE = 2787654321;
  const SERIAL_RECON = 2787654322;

  it("a late close from a replaced session does not stop the new session's polling", async () => {
    const { token, id } = await pairAgent("Race agent", "token-bob");
    const fa1 = new FakeAgent();
    await fa1.connect(token);
    fa1.hello();
    await fa1.waitMessage("ready");
    fa1.reportStick(SERIAL_RACE);
    await waitFor(() => server.hub.hasStick(id, SERIAL_RACE), 5000, "stick report");

    const envId = await createAgentEnv("token-bob", id, SERIAL_RACE);
    await waitFor(() => server.manager.isAttached(SERIAL_RACE), 10000, "polling to start");

    // Keep a handle on the internal session, exactly what the close handler
    // of a half-open socket would later pass to detachAll.
    const hubAny = server.hub as unknown as {
      sessions: Map<string, unknown>;
      detachAll(session: unknown): Promise<void>;
    };
    const staleSession = hubAny.sessions.get(id);
    expect(staleSession).toBeDefined();

    // Reconnect: the server replaces the session and kicks the old socket.
    const fa2 = new FakeAgent();
    await fa2.connect(token);
    fa2.hello();
    await fa2.waitMessage("ready");
    expect(await fa1.closeCode).toBe(AGENT_CLOSE_REPLACED);
    fa2.reportStick(SERIAL_RACE);
    await waitFor(() => server.manager.isAttached(SERIAL_RACE), 10000, "re-attach after replacement");

    // The replaced socket's close event arrives late (half-open connections
    // can take ~30 s). It must not stop the new session's polling.
    await hubAny.detachAll(staleSession);
    expect(await server.manager.isAttached(SERIAL_RACE)).toBe(true);

    const logger = await server.app.inject({
      url: `/api/environments/${envId}/logger`,
      headers: auth("token-bob"),
    });
    expect(logger.json()).toMatchObject({ connected: true });

    // A real close of the current session still detaches.
    fa2.close();
    await fa2.closeCode;
    await waitFor(
      async () => !(await server.manager.isAttached(SERIAL_RACE)),
      5000,
      "detach when the live session closes",
    );
  }, 30000);

  it("an identical stick report re-attaches a stick whose polling was lost", async () => {
    const { token, id } = await pairAgent("Reconcile agent", "token-bob");
    const fa = new FakeAgent();
    await fa.connect(token);
    fa.hello();
    await fa.waitMessage("ready");
    fa.reportStick(SERIAL_RECON);
    await waitFor(() => server.hub.hasStick(id, SERIAL_RECON), 5000, "stick report");
    await createAgentEnv("token-bob", id, SERIAL_RECON);
    await waitFor(() => server.manager.isAttached(SERIAL_RECON), 10000, "polling to start");

    // Simulate a wrongful detach (what the old race produced).
    await server.manager.detachSerial(SERIAL_RECON);
    expect(await server.manager.isAttached(SERIAL_RECON)).toBe(false);

    // The agent re-reports the same unchanged stick list (it does this at
    // least once a minute). A set-diff would ignore it; reconciliation heals.
    fa.reportStick(SERIAL_RECON);
    await waitFor(() => server.manager.isAttached(SERIAL_RECON), 10000, "reconciliation re-attach");

    fa.close();
    await fa.closeCode;
  }, 30000);

  it("sessions that stop answering pings are terminated", async () => {
    const { token } = await pairAgent("Mute agent", "token-bob");
    const fa = new FakeAgent();
    await fa.connect(token, { autoPong: false });
    fa.hello();
    await fa.waitMessage("ready");
    // Heartbeat is 250 ms in tests; two missed pongs ≈ 750 ms, then terminate.
    const code = await fa.closeCode;
    expect(code).toBe(1006); // abnormal closure: server terminated the socket
  }, 15000);

  it("ready advertises versions and /api/agents exposes the agent's version", async () => {
    const cfg = config as { agentLatestVersion: string; agentMinVersion: string };
    const before = { latest: cfg.agentLatestVersion, min: cfg.agentMinVersion };
    cfg.agentLatestVersion = "9.9.9";
    cfg.agentMinVersion = "0.0.1";
    try {
      const { token, id } = await pairAgent("Versioned agent", "token-bob");
      const fa = new FakeAgent();
      await fa.connect(token);
      fa.hello();
      const ready = await fa.waitMessage("ready");
      expect(ready).toMatchObject({ latestAgentVersion: "9.9.9", minAgentVersion: "0.0.1" });
      expect(typeof ready.serverTime).toBe("string");

      const list = await server.app.inject({ url: "/api/agents", headers: auth("token-bob") });
      const entry = (list.json() as { id: string; version: string | null }[]).find((a) => a.id === id);
      expect(entry).toMatchObject({ version: "0.0.0-test" });

      const sys = await server.app.inject({ url: "/api/system/config" });
      expect(sys.json().agent).toMatchObject({ latestVersion: "9.9.9", minVersion: "0.0.1" });

      fa.close();
      await fa.closeCode;
    } finally {
      cfg.agentLatestVersion = before.latest;
      cfg.agentMinVersion = before.min;
    }
  });
});

describe("re-pairing keeps the agent id", () => {
  const SERIAL_REPAIR = 2787654323;
  let repairAgentId: string;

  it("previousAgentId rotates the token, keeps the id, and environments stay linked", async () => {
    const { token: tokenA, id } = await pairAgent("Repair me", "token-bob");
    repairAgentId = id;
    const fa = new FakeAgent();
    await fa.connect(tokenA);
    fa.hello();
    await fa.waitMessage("ready");
    fa.reportStick(SERIAL_REPAIR);
    await waitFor(() => server.hub.hasStick(id, SERIAL_REPAIR), 5000, "stick report");
    const envId = await createAgentEnv("token-bob", id, SERIAL_REPAIR);
    await waitFor(() => server.manager.isAttached(SERIAL_REPAIR), 10000, "polling to start");

    // The device lost its token (reinstall, keychain reset) and went offline.
    fa.close();
    await fa.closeCode;

    // Re-pair, telling the server who we used to be.
    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "Repair me", platform: "linux", previousAgentId: id },
      remoteAddress: `10.99.0.${++pairIpCounter}`,
    });
    expect(start.statusCode).toBe(200);
    const { deviceCode, userCode } = start.json();

    // The approval page announces the replacement.
    const info = await server.app.inject({
      url: `/api/agent/pair/${userCode}`,
      headers: auth("token-bob"),
    });
    expect(info.json().replacesAgent).toMatchObject({ id, name: "Repair me" });

    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${userCode}/approve`,
      headers: auth("token-bob"),
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ agentId: id, reused: true });

    const polled = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(polled.json()).toMatchObject({ status: "approved", agentId: id });
    const tokenB = polled.json().token as string;
    expect(tokenB).not.toBe(tokenA);

    // The old credential is dead; the new one connects as the same agent.
    const dead = new FakeAgent();
    await dead.connect(tokenA);
    expect(await dead.closeCode).toBe(AGENT_CLOSE_UNAUTHORIZED);

    const fb = new FakeAgent();
    await fb.connect(tokenB);
    fb.hello();
    const ready = await fb.waitMessage("ready");
    expect(ready).toMatchObject({ agentId: id });
    fb.reportStick(SERIAL_REPAIR);
    await waitFor(() => server.manager.isAttached(SERIAL_REPAIR), 10000, "env polls again");

    // Still one agent, with the environment attached to it.
    const list = await server.app.inject({ url: "/api/agents", headers: auth("token-bob") });
    const mine = (list.json() as { name: string; id: string; environments: { id: string }[] }[])
      .filter((a) => a.name === "Repair me");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(id);
    expect(mine[0].environments).toEqual([expect.objectContaining({ id: envId, serial: SERIAL_REPAIR })]);

    fb.close();
    await fb.closeCode;
  }, 30000);

  it("falls back to an offline agent with the same name and platform", async () => {
    // Only offline agents are reused; wait out the previous test's close.
    await waitFor(() => !server.hub.isOnline(repairAgentId), 5000, "agent to go offline");
    // The hub stored the platform from the agent's hello ("macos" in
    // FakeAgent) — a real agent reports the same platform in both places.
    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "Repair me", platform: "macos" },
      remoteAddress: `10.99.0.${++pairIpCounter}`,
    });
    const { deviceCode, userCode } = start.json();
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${userCode}/approve`,
      headers: auth("token-bob"),
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ agentId: repairAgentId, reused: true });
    const polled = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/poll",
      payload: { deviceCode },
    });
    expect(polled.json()).toMatchObject({ status: "approved", agentId: repairAgentId });
  });

  it("a previousAgentId owned by someone else is ignored and a new agent is created", async () => {
    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "Alice box", platform: "linux", previousAgentId: repairAgentId },
      remoteAddress: `10.99.0.${++pairIpCounter}`,
    });
    const { userCode } = start.json();

    // Alice doesn't own bob's agent: no replacement is announced...
    const info = await server.app.inject({
      url: `/api/agent/pair/${userCode}`,
      headers: auth("token-alice"),
    });
    expect(info.json().replacesAgent).toBeNull();

    // ...and approving creates a brand-new agent instead of hijacking bob's.
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${userCode}/approve`,
      headers: auth("token-alice"),
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().reused).toBe(false);
    expect(approve.json().agentId).not.toBe(repairAgentId);
  });
});

describe("transport security", () => {
  it("AGENT_REQUIRE_TLS rejects pairing requests that did not arrive over https", async () => {
    const cfg = config as { agentRequireTls: boolean };
    const before = cfg.agentRequireTls;
    cfg.agentRequireTls = true;
    try {
      const plain = await server.app.inject({
        method: "POST",
        url: "/api/agent/pair/start",
        payload: { name: "PC", platform: "linux" },
      });
      expect(plain.statusCode).toBe(426);

      // Behind the TLS proxy the forwarded protocol is https (trustProxy).
      const forwarded = await server.app.inject({
        method: "POST",
        url: "/api/agent/pair/start",
        headers: { "x-forwarded-proto": "https" },
        payload: { name: "PC", platform: "linux" },
      });
      expect(forwarded.statusCode).toBe(200);
    } finally {
      cfg.agentRequireTls = before;
    }
  });

  it("AGENT_REQUIRE_TLS closes plain /ws/agent connections", async () => {
    const cfg = config as { agentRequireTls: boolean };
    const before = cfg.agentRequireTls;
    cfg.agentRequireTls = true;
    try {
      const agent = new FakeAgent();
      await agent.connect("hat_" + "0".repeat(64));
      expect(await agent.closeCode).toBe(AGENT_CLOSE_PROTOCOL); // 4426 TLS required
    } finally {
      cfg.agentRequireTls = before;
    }
  });

  it("tokens in the URL never authenticate — only the Authorization header does", async () => {
    const { token } = await pairAgent("Query smuggler");
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/agent?token=${token}`);
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    expect(code).toBe(AGENT_CLOSE_UNAUTHORIZED);
  });

  it("oversize messages are rejected by the payload cap", async () => {
    const { token } = await pairAgent("Chatty");
    const agent = new FakeAgent();
    await agent.connect(token);
    agent.hello();
    await agent.waitMessage("ready");
    agent.ws.send(JSON.stringify({ type: "sticks", sticks: [], pad: "x".repeat(70 * 1024) }));
    // ws enforces maxPayload with 1009 (message too big) before our parsing runs.
    expect(await agent.closeCode).toBe(1009);
  });

  it("caps the number of paired agents per user", async () => {
    // Alice already has agents from the tests above; fill up to the limit.
    const list = await server.app.inject({ url: "/api/agents", headers: auth("token-alice") });
    const existing = list.json().length as number;
    for (let i = existing; i < config.maxAgentsPerUser; i++) {
      await pairAgent(`Filler ${i}`);
    }

    const start = await server.app.inject({
      method: "POST",
      url: "/api/agent/pair/start",
      payload: { name: "One too many", platform: "linux" },
    });
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${start.json().userCode}/approve`,
      headers: auth("token-alice"),
    });
    expect(approve.statusCode).toBe(403);
    // The error tells the user how to free a slot.
    expect(approve.json().error).toContain("agent limit reached");
    expect(approve.json().error).toContain("Revoke");
  });
});
