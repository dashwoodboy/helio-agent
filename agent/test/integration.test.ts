/**
 * Full-stack integration: the real agent core (UDP discovery → StickRegistry
 * → AgentLink) talking to the real backend (pairing REST + /ws/agent hub)
 * with a fake Solarman stick on the loopback "LAN". Covers the complete
 * user story: pair with a browser-approved code, discover the stick, see it
 * on the website, probe it, claim it with an environment, and watch live
 * data flow server ← agent ← stick.
 *
 * Requires a Postgres reachable at TEST_DATABASE_ADMIN_URL (defaults to the
 * backend dev container on :55432). The test database is recreated each run.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db } from "../../backend/src/db/client.js";
import { runMigrations } from "../../backend/src/db/migrate.js";
import { StaticVerifier, type AuthUser } from "../../backend/src/auth/verifier.js";
import { buildServer, type BuiltServer } from "../../backend/src/server.js";

import { discoverOnce } from "../src/core/discovery.js";
import { StickRegistry } from "../src/core/sticks.js";
import { AgentLink } from "../src/core/link.js";
import { startPairing, pollPairing } from "../src/core/pairing.js";
import { startFakeStick, type FakeStickHandle } from "./fakeStick.js";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://deye:deye@localhost:55432/deye";
const TEST_DB = "deye_test_agent_integration";

// CI runners (the installer build matrix) have no Postgres; the suite runs
// locally and wherever TEST_DATABASE_ADMIN_URL is provided explicitly.
const HAS_DB = !process.env.CI || Boolean(process.env.TEST_DATABASE_ADMIN_URL);

const USERS: Record<string, AuthUser> = {
  "token-alice": { uid: "uid-alice", email: "alice@test.dev", emailVerified: true, displayName: "Alice" },
};
const auth = { authorization: "Bearer token-alice" };

const SERIAL = 2799001122;

let server: BuiltServer;
let db: Db;
let serverUrl: string;
let stick: FakeStickHandle;
let registry: StickRegistry;
let link: AgentLink | null = null;
/** Registries created mid-suite (replacement/re-pair); closed in afterAll. */
const extraRegistries: StickRegistry[] = [];

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!HAS_DB)("agent core <-> backend <-> fake stick", () => {
beforeAll(async () => {
  // Fresh database for this suite.
  const admin = createDb(ADMIN_URL);
  await admin.pool.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.pool.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.pool.end();

  const created = createDb(ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`));
  db = created.db;
  await runMigrations(db, 1);

  // Real backend on an ephemeral port. Loopback plain-http is the one case
  // the agent's server-URL policy allows without TLS.
  server = await buildServer({
    db,
    verifier: new StaticVerifier(new Map(Object.entries(USERS))),
    withGateway: false,
    pollOpts: { pollIntervalMs: 500, fullPollIntervalMs: 5000 },
    logLevel: "silent",
  });
  await server.app.ready();
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  serverUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;

  stick = await startFakeStick({ serial: SERIAL });
  registry = new StickRegistry();
}, 60000);

afterAll(async () => {
  link?.stop();
  await registry?.close();
  for (const r of extraRegistries) await r.close();
  await stick?.stop();
  await server?.hub.closeAll();
  await server?.manager.shutdown();
  await server?.app.close();
}, 30000);

// Shared across the serial steps below.
let agentToken: string;
let agentId: string;
let envId: string;

  it("pairs with the real device-flow client", async () => {
    const codes = await startPairing(serverUrl, { name: "Integration PC", platform: "linux" });
    expect(codes.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(codes.verificationUrl).toBe(
      `${serverUrl}/agent/link?code=${encodeURIComponent(codes.userCode)}`,
    );

    expect(await pollPairing(serverUrl, codes.deviceCode)).toEqual({ status: "pending" });

    // The user approves the code in their signed-in browser.
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${codes.userCode}/approve`,
      headers: auth,
    });
    expect(approve.statusCode).toBe(200);

    const outcome = await pollPairing(serverUrl, codes.deviceCode);
    expect(outcome.status).toBe("approved");
    if (outcome.status !== "approved") throw new Error("unreachable");
    agentToken = outcome.token;
    agentId = outcome.agentId;
    expect(agentToken).toMatch(/^hat_[0-9a-f]{64}$/);
  });

  it("discovers the fake stick over real UDP", async () => {
    const found = await discoverOnce({
      targets: [{ address: "127.0.0.1", port: stick.udpPort }],
      timeoutMs: 1500,
    });
    expect(found).toEqual([{ ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: SERIAL }]);

    // The fake stick's Modbus port is ephemeral; a real stick listens on 8899.
    registry.update(found.map((s) => ({ ...s, port: stick.tcpPort })));
    expect(registry.report()).toEqual([
      { serial: SERIAL, ip: "127.0.0.1", mac: "AABBCCDDEEFF", reachable: true, manual: false },
    ]);
  });

  it("connects the real link, surfaces the stick on the website, probes and feeds an environment", async () => {
    link = new AgentLink({
      serverUrl,
      token: agentToken,
      name: "Integration PC",
      platform: "linux",
      version: "0.0.0-test",
      registry,
    });
    link.start();
    await waitFor(() => link!.status === "online", 10000, "agent link online");
    await waitFor(() => server.hub.hasStick(agentId, SERIAL), 5000, "stick report at the hub");

    // The website lists the agent online with the discovered stick.
    const list = await server.app.inject({ url: "/api/agents", headers: auth });
    expect(list.json()).toMatchObject([
      {
        id: agentId,
        name: "Integration PC",
        online: true,
        sticks: [{ serial: SERIAL, ip: "127.0.0.1", reachable: true }],
      },
    ]);

    // "Test" button: detect + live sample through agent RPC → stick Modbus.
    const probe = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/test`,
      headers: auth,
      payload: { serial: SERIAL },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
    expect(probe.json().config).toMatchObject({ phases: 1, hasBattery: true });

    // Claim the stick with an environment; live data flows end to end.
    const create = await server.app.inject({
      method: "POST",
      url: "/api/environments",
      headers: auth,
      payload: {
        name: "Integration env",
        timezone: "Europe/Lisbon",
        lat: 38.72,
        lon: -9.14,
        sourceType: "agent",
        agentId,
        loggerSerial: SERIAL,
      },
    });
    expect(create.statusCode).toBe(201);
    envId = create.json().id as string;

    await waitFor(
      async () => (await server.manager.get(envId))?.liveState.current !== null,
      30000,
      "live snapshot through the real agent",
    );
    const rt = (await server.manager.get(envId))!;
    expect(rt.inverterConfig.phases).toBe(1);
    expect(rt.liveState.current!.soc).toBeGreaterThanOrEqual(0);

    const logger = await server.app.inject({
      url: `/api/environments/${envId}/logger`,
      headers: auth,
    });
    expect(logger.json()).toMatchObject({ serial: SERIAL, connected: true });
  }, 60000);

  it("reads and WRITES inverter settings through the agent (not just streaming)", async () => {
    // Read the inverter's own configuration over agent RPC.
    const read = await server.app.inject({
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ supported: true, online: true, writesEnabled: true });
    const before = read.json().settings.battMaxChargeA as number;
    const target = before === 123 ? 124 : 123;

    // Change a setting; the write travels API → InverterControl →
    // AgentStickTransport RPC → agent → Modbus 0x06/0x10 on the stick.
    const apply = await server.app.inject({
      method: "PUT",
      url: `/api/environments/${envId}/inverter/settings`,
      headers: auth,
      payload: { battMaxChargeA: target },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().ok).toBe(true);
    expect(apply.json().results).toEqual([
      expect.objectContaining({ key: "battMaxChargeA", ok: true, from: before, to: target }),
    ]);
    // The write-back verification re-reads the register.
    expect(apply.json().read.settings.battMaxChargeA).toBe(target);

    // The register in the fake stick's bank really changed (reg 210, 1 A/LSB).
    expect(stick.registers.get(210)).toBe(target);
  }, 30000);

  it("identifies a manual stick with unknown serial once the user types it on the website", async () => {
    // Swap the agent for one that only knows the stick by IP + port (manual
    // entry, UDP probe unanswered) — the exact "Serial unknown" situation.
    link!.stop();
    const manualRegistry = new StickRegistry();
    manualRegistry.addManual("127.0.0.1", stick.tcpPort);
    expect(manualRegistry.report()).toEqual([
      { serial: null, ip: "127.0.0.1", mac: null, reachable: false, manual: true },
    ]);

    link = new AgentLink({
      serverUrl,
      token: agentToken,
      name: "Integration PC",
      platform: "linux",
      version: "0.0.0-test",
      registry: manualRegistry,
    });
    link.start();
    await waitFor(() => link!.status === "online", 10000, "agent link online again");
    await waitFor(
      () => server.hub.sticksFor(agentId).some((s) => s.serial === null),
      5000,
      "serial-less stick at the hub",
    );

    // The user types the label serial and presses Test: the backend routes it
    // to the serial-less candidate, the agent tries that serial on the stick,
    // and the stick answers because it really is its own serial.
    const probe = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/test`,
      headers: auth,
      payload: { serial: SERIAL },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);

    // The agent adopted the serial and reports the stick properly from now on.
    expect(manualRegistry.report()[0]).toMatchObject({ serial: SERIAL, manual: true });
    link.reportSticks(true);
    await waitFor(() => server.hub.hasStick(agentId, SERIAL), 5000, "adopted serial at the hub");
    await manualRegistry.close();
  }, 30000);

  it("hands the session to a replacement agent without interrupting the environment", async () => {
    // A second process connects with the same credential (reinstall, double
    // start). The server must hand the session over: the old link learns it
    // was replaced, and — the root cause of the "connected but no data" bug —
    // the old socket's close must NOT detach the polling the new session owns.
    const replacementRegistry = new StickRegistry();
    extraRegistries.push(replacementRegistry);
    replacementRegistry.update([
      { ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: SERIAL, port: stick.tcpPort },
    ]);
    const old = link!;
    link = new AgentLink({
      serverUrl,
      token: agentToken,
      name: "Integration PC",
      platform: "linux",
      version: "0.0.0-test",
      registry: replacementRegistry,
    });
    link.start();

    await waitFor(() => link!.status === "online", 10000, "replacement link online");
    await waitFor(() => old.status === "replaced", 5000, "old link told it was replaced");
    old.stop();

    // Data keeps flowing through the replacement session.
    await waitFor(
      async () => {
        const res = await server.app.inject({
          url: `/api/environments/${envId}/logger`,
          headers: auth,
        });
        return (res.json() as { connected: boolean }).connected;
      },
      15000,
      "environment connected through the replacement session",
    );
  }, 30000);

  it("re-pairs keeping the agent id, so the environment survives a token loss", async () => {
    // Reinstall / lost keychain: the agent pairs again, sending its previous
    // id. The server rotates the credential but keeps the identity — the
    // environment stays linked without touching the website.
    const codes = await startPairing(serverUrl, {
      name: "Integration PC",
      platform: "linux",
      previousAgentId: agentId,
    });
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/agent/pair/${codes.userCode}/approve`,
      headers: auth,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ ok: true, agentId, reused: true });

    const outcome = await pollPairing(serverUrl, codes.deviceCode);
    expect(outcome.status).toBe("approved");
    if (outcome.status !== "approved") throw new Error("unreachable");
    expect(outcome.agentId).toBe(agentId); // same identity
    expect(outcome.token).not.toBe(agentToken); // new credential
    const oldToken = agentToken;
    agentToken = outcome.token;

    // The old credential is dead now.
    link!.stop();
    const staleRegistry = new StickRegistry();
    const stale = new AgentLink({
      serverUrl,
      token: oldToken,
      name: "Integration PC",
      platform: "linux",
      version: "0.0.0-test",
      registry: staleRegistry,
    });
    stale.start();
    await waitFor(
      () => stale.status === "unauthorized" || stale.status === "offline",
      10000,
      "old token rejected",
    );
    expect(stale.status).not.toBe("online");
    stale.stop();
    await staleRegistry.close();

    // The new credential connects as the same agent and the environment heals.
    const freshRegistry = new StickRegistry();
    extraRegistries.push(freshRegistry);
    freshRegistry.update([
      { ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: SERIAL, port: stick.tcpPort },
    ]);
    link = new AgentLink({
      serverUrl,
      token: agentToken,
      name: "Integration PC",
      platform: "linux",
      version: "0.0.0-test",
      registry: freshRegistry,
    });
    link.start();
    await waitFor(() => link!.status === "online", 10000, "re-paired link online");
    await waitFor(
      async () => {
        const res = await server.app.inject({
          url: `/api/environments/${envId}/logger`,
          headers: auth,
        });
        return (res.json() as { connected: boolean }).connected;
      },
      15000,
      "environment connected after re-pairing",
    );

    // Still ONE agent on the account (no zombie created by the re-pair).
    const list = await server.app.inject({ url: "/api/agents", headers: auth });
    expect((list.json() as unknown[]).length).toBe(1);
  }, 30000);

  it("detaches the environment when the agent stops", async () => {
    link!.stop();
    link = null;
    await waitFor(() => !server.hub.isOnline(agentId), 5000, "agent offline at the hub");
    const offline = await server.app.inject({
      url: `/api/environments/${envId}/logger`,
      headers: auth,
    });
    expect(offline.json()).toMatchObject({ connected: false });
  }, 30000);
});
