/**
 * Headless Helio Agent for servers (no GUI, no Electron). Same core as the
 * desktop app: UDP/TCP discovery, outbound TLS link, browser-approved
 * pairing. Designed to run under systemd or in a shell.
 *
 *   helio-agent pair [--server <url>] [--name <name>] [--ca <pem file>]
 *   helio-agent run
 *   helio-agent sign-out
 *
 * The token is stored with 0600 permissions in
 * $XDG_CONFIG_HOME/helio-agent/config.json (no OS keyring in headless mode).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Agent as HttpAgent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AgentCore, AGENT_VERSION, defaultAgentName } from "../core/agent.js";
import { isPrivateIp, isValidIpv4 } from "../core/discovery.js";
import { AgentLogger } from "../core/logging.js";
import { preflight } from "../core/net.js";
import { startPairing, waitForApproval } from "../core/pairing.js";
import { parseServerUrl } from "../core/serverUrl.js";
import { startLocalUi, type LocalUiHandle, type LocalUiState } from "./localUi.js";
import { selfUpdate } from "./selfUpdate.js";
import type { LinkStatusDetail } from "../core/link.js";
import type { StickReport } from "../core/sticks.js";

/** Build-time default (see scripts/build-cli.mjs `define`). */
declare const __HELIO_SERVER_URL__: string;
const DEFAULT_SERVER_URL =
  typeof __HELIO_SERVER_URL__ !== "undefined" ? __HELIO_SERVER_URL__ : "https://helio-power.eu";

interface CliConfig {
  serverUrl: string;
  token: string | null;
  agentId: string | null;
  name: string;
  caFile: string | null;
  manualSticks: { ip: string; port: number; serial?: number | null }[];
  /** Last sticks discovery saw; seeds the next run's discovery. */
  knownSticks: { ip: string; port?: number; serial?: number | null }[];
}

const configFile = () =>
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "helio-agent",
    "config.json",
  );

function loadConfig(): CliConfig {
  let stored: Partial<CliConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<CliConfig>;
  } catch {
    // first run
  }
  return {
    serverUrl: stored.serverUrl ?? DEFAULT_SERVER_URL,
    token: stored.token ?? null,
    agentId: stored.agentId ?? null,
    name: stored.name ?? defaultAgentName(),
    caFile: stored.caFile ?? null,
    manualSticks: Array.isArray(stored.manualSticks) ? stored.manualSticks : [],
    knownSticks: Array.isArray(stored.knownSticks) ? stored.knownSticks : [],
  };
}

function saveConfig(config: CliConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Set up by cmdRun when --log-file is given; console-only otherwise. */
let fileLogger: AgentLogger | null = null;
/** Ring buffer behind the local status page's "Recent log". */
const uiLog = new AgentLogger({ capacity: 200 });

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
  fileLogger?.log(msg);
  uiLog.log(msg);
}

function readCa(config: CliConfig): Buffer | undefined {
  if (!config.caFile) return undefined;
  return fs.readFileSync(config.caFile);
}

/**
 * Honour HTTPS_PROXY/ALL_PROXY and NO_PROXY for the WebSocket uplink (ws
 * ignores proxy env vars by itself). For plain HTTP requests, run Node with
 * NODE_USE_ENV_PROXY=1 so global fetch honours the same variables.
 */
function proxyAgentFor(serverUrl: string): HttpAgent | undefined {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || "";
  if (!proxy) return undefined;
  try {
    const host = new URL(parseServerUrl(serverUrl).baseUrl).hostname.toLowerCase();
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const skipped = noProxy.some(
      (n) => n === "*" || host === n || host.endsWith(`.${n.replace(/^\./, "")}`),
    );
    if (skipped) return undefined;
    return new HttpsProxyAgent(proxy) as unknown as HttpAgent;
  } catch {
    return undefined;
  }
}

/** Tiny flag parser: --key value pairs after the command. */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined) {
      throw new Error(`Unexpected argument "${args[i]}" — see helio-agent --help`);
    }
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
}

const HELP = `Helio Agent ${AGENT_VERSION} — headless mode for servers

Finds Solarman sticks on this machine's network and relays them to your
Helio server over a single outbound TLS connection.

Usage:
  helio-agent pair [--server <url>] [--name <name>] [--ca <pem file>]
      Link this machine to your Helio account. Prints a code and a link;
      approve it in your signed-in browser (on any device).
  helio-agent run [--log-file <path>] [--ui on|off] [--ui-port <port>]
                  [--self-update on|off]
      Run the agent (foreground). Not paired yet? run starts the pairing by
      itself: the code shows in the logs and on the local status page
      (http://<this device>/ — port 80, or 8080 without privileges; read
      only, never shows the token; --ui off disables it). When a newer
      release is published, the bundle updates itself (sha256 + ed25519
      verified) and exits for the service manager to restart it.
      Use a service manager to keep the agent running:

        # /etc/systemd/system/helio-agent.service
        [Unit]
        Description=Helio Agent
        After=network-online.target
        [Service]
        ExecStart=/usr/bin/node /opt/helio/helio-agent-cli.cjs run
        Restart=on-failure
        User=helio
        [Install]
        WantedBy=multi-user.target

  helio-agent add-stick --ip <ip> [--port <port>] [--serial <serial>]
      Pin a stick discovery can't see (other subnet, probe ignored). Pass
      the label serial, or leave it out to pick it up automatically when
      the stick answers. Default port: 8899. Public addresses are accepted
      with a warning — only add devices you own.
  helio-agent remove-stick --ip <ip>
      Forget a manually added stick.
  helio-agent doctor
      Check the connection step by step (DNS, TLS, server, WebSocket) and
      print what breaks and how to fix it. Exit code 0 only when all pass.
  helio-agent status
      Show the stored state: server, name, paired or not, sticks.
  helio-agent sign-out
      Forget the stored token (also revoke the agent on the website).

The token is stored with 0600 permissions in
~/.config/helio-agent/config.json. Only https:// servers are accepted
(plain http solely for localhost); certificate verification is never
disabled — --ca adds a private CA on top of the system store.

Networks with a proxy or a private CA:
  HTTPS_PROXY / NO_PROXY      Used for the WebSocket uplink. Also run with
                              NODE_USE_ENV_PROXY=1 so HTTP requests
                              (pairing, updates) follow the same proxy.
  NODE_USE_SYSTEM_CA=1        Trust the OS certificate store (antivirus or
                              company CAs) in addition to the bundled roots.
  --ca <pem file>             Trust one extra CA (private deployments).
`;

async function cmdPair(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  if (flags.server) config.serverUrl = parseServerUrl(flags.server).baseUrl;
  else parseServerUrl(config.serverUrl); // validate the stored/default URL
  if (flags.name) config.name = flags.name;
  if (flags.ca) {
    fs.readFileSync(flags.ca); // fail early with a clear message
    config.caFile = path.resolve(flags.ca);
  }

  const codes = await startPairing(config.serverUrl, {
    name: config.name,
    platform: "linux",
    // Re-pairing keeps this machine's identity (and its environments).
    previousAgentId: config.agentId,
  });
  console.log(`\n  Pairing code:  ${codes.userCode}`);
  console.log(`  Approve it at: ${codes.verificationUrl}`);
  console.log(`\n  Waiting for approval (code expires in ${Math.round(codes.expiresInS / 60)} minutes)...`);

  const outcome = await waitForApproval(config.serverUrl, codes);
  if (outcome.status !== "approved") {
    console.error(
      outcome.status === "denied"
        ? "The request was denied on the website."
        : "The code expired — run pair again.",
    );
    process.exit(1);
  }
  config.token = outcome.token;
  config.agentId = outcome.agentId;
  saveConfig(config);
  console.log(`\n  Paired as "${config.name}". Start it with: helio-agent run`);
}

/**
 * Connection check for humans: the same preflight the desktop app runs,
 * printed step by step. The usual culprits (DNS, proxy, TLS-inspecting
 * antivirus, blocked WebSockets) each fail a different step.
 */
async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  console.log(`Helio Agent ${AGENT_VERSION} — checking ${config.serverUrl}\n`);
  const steps = await preflight(config.serverUrl, { ca: readCa(config) });
  let allOk = true;
  for (const step of steps) {
    allOk = allOk && step.ok;
    console.log(`  [${step.ok ? " ok " : "FAIL"}] ${step.label}: ${step.detail}`);
  }
  console.log("");
  console.log(config.token ? "Paired: yes — start with: helio-agent run" : "Paired: no — run: helio-agent pair");
  if (!allOk) process.exit(1);
}

function cmdStatus(): void {
  const config = loadConfig();
  console.log(`Helio Agent ${AGENT_VERSION}`);
  console.log(`  Server:        ${config.serverUrl}`);
  console.log(`  Name:          ${config.name}`);
  console.log(`  Paired:        ${config.token ? "yes" : "no — run: helio-agent pair"}`);
  if (config.agentId) console.log(`  Agent id:      ${config.agentId}`);
  if (config.caFile) console.log(`  Extra CA:      ${config.caFile}`);
  if (config.manualSticks.length > 0) {
    console.log(`  Manual sticks: ${config.manualSticks.map((s) => `${s.ip}:${s.port}`).join(", ")}`);
  }
  if (config.knownSticks.length > 0) {
    console.log(
      `  Known sticks:  ${config.knownSticks.map((s) => `${s.serial ?? "?"}@${s.ip}`).join(", ")}`,
    );
  }
  console.log(`  Config file:   ${configFile()}`);
  console.log("\nConnectivity check: helio-agent doctor");
}

async function cmdRun(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  if (flags["log-file"]) {
    fileLogger = new AgentLogger({ file: path.resolve(flags["log-file"]) });
  }

  let core: AgentCore | null = null;
  let localUi: LocalUiHandle | null = null;
  // Mirrors for the local status page.
  let statusDetail: LinkStatusDetail = { status: "idle", code: null, message: "", nextRetryAt: null };
  let sticks: StickReport[] = [];
  let pairing: LocalUiState["pairing"] = null;
  let pairingError: string | null = null;

  const startCore = (): void => {
    core = new AgentCore({
      serverUrl: config.serverUrl,
      token: config.token!,
      name: config.name,
      ca: readCa(config),
      wsAgent: proxyAgentFor(config.serverUrl),
      manualSticks: config.manualSticks,
      knownSticks: config.knownSticks,
      log,
    });

    core.on("status", (detail: LinkStatusDetail) => {
      statusDetail = detail;
      log(`status: ${detail.status}${detail.message ? ` — ${detail.message}` : ""}`);
      if (detail.status === "unauthorized") {
        console.error("The server rejected the token (revoked?) — run pair again.");
        void shutdownWith(1);
      }
      if (detail.status === "replaced") {
        console.error("Another instance of this agent connected and took over.");
        void shutdownWith(1);
      }
      if (detail.status === "update_required") {
        console.error(detail.message || "The server requires a newer agent version.");
        void shutdownWith(1);
      }
    });
    core.on("sticks", (reported: StickReport[]) => {
      sticks = reported;
      log(
        reported.length === 0
          ? `no sticks visible on this network${core?.discoveryIssue ? ` (${core.discoveryIssue})` : ""}`
          : `sticks: ${reported.map((s) => `${s.serial ?? "serial unknown"}@${s.ip}`).join(", ")}`,
      );
      // Remember what discovery saw, to seed the next run.
      const seen = reported
        .filter((s) => !s.manual && s.reachable)
        .map((s) => ({ ip: s.ip, serial: s.serial }));
      if (JSON.stringify(seen) !== JSON.stringify(config.knownSticks)) {
        config.knownSticks = seen;
        saveConfig(config);
      }
    });

    core.start();
  };

  /**
   * Headless pairing: ask for a code, print it (and show it on the local
   * page), wait; when it expires unapproved, ask for a fresh one. This is
   * what makes the Pi image and the Docker container zero-SSH: the code is
   * in `journalctl`/`docker logs` AND on http://<device>/.
   */
  const pairLoop = async (): Promise<void> => {
    while (!config.token) {
      try {
        const codes = await startPairing(config.serverUrl, {
          name: config.name,
          platform: "linux",
          previousAgentId: config.agentId,
        });
        pairing = {
          userCode: codes.userCode,
          verificationUrl: codes.verificationUrl,
          expiresAt: Date.now() + codes.expiresInS * 1000,
        };
        pairingError = null;
        log(`pairing code: ${codes.userCode} — approve at ${codes.verificationUrl}`);
        const outcome = await waitForApproval(config.serverUrl, codes);
        if (outcome.status === "approved") {
          config.token = outcome.token;
          config.agentId = outcome.agentId;
          saveConfig(config);
          pairing = null;
          log(`paired as "${config.name}" — starting the relay`);
          startCore();
          return;
        }
        pairing = null;
        if (outcome.status === "denied") {
          pairingError = "The request was denied on the website. Retrying with a new code…";
          log("pairing denied — requesting a new code in 30 s");
          await new Promise((r) => setTimeout(r, 30_000));
        } else {
          log("pairing code expired — requesting a new one");
        }
      } catch (err) {
        pairing = null;
        pairingError = (err as Error).message;
        log(`pairing failed: ${pairingError} — retrying in 15 s`);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  };

  // Local status page (http, read-only). --ui off disables it; --ui-port
  // picks the port (default 80, falling back to 8080 without privileges).
  if ((flags.ui ?? "on") !== "off") {
    try {
      localUi = await startLocalUi({
        port: flags["ui-port"] ? Number(flags["ui-port"]) : 80,
        getState: (): LocalUiState => ({
          version: AGENT_VERSION,
          serverUrl: config.serverUrl,
          name: config.name,
          paired: config.token !== null,
          pairing: config.token ? null : pairing,
          pairingError,
          statusDetail,
          sticks: sticks.map((s) => ({
            serial: s.serial,
            ip: s.ip,
            reachable: s.reachable,
            manual: s.manual,
          })),
          discoveryIssue: core?.discoveryIssue ?? null,
          logLines: uiLog.lines(100),
        }),
        runPreflight: () => preflight(config.serverUrl, { ca: readCa(config) }),
        log,
      });
    } catch (err) {
      log(`local status page failed to start: ${(err as Error).message} — continuing without it`);
    }
  }

  const shutdownWith = async (code: number): Promise<void> => {
    await core?.stop();
    await localUi?.close();
    process.exit(code);
  };
  const shutdown = (signal: string) => {
    log(`${signal} received, stopping`);
    void shutdownWith(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Self-update: Pi images and installer setups never get re-flashed, so
  // the bundle replaces itself from the release (sha256 + ed25519 verified)
  // and exits for systemd to restart the new version. --self-update off
  // opts out (e.g. when a package manager owns the file).
  if ((flags["self-update"] ?? "on") !== "off") {
    const scriptPath = process.argv[1] ?? "";
    const checkUpdate = async (): Promise<void> => {
      const result = await selfUpdate(AGENT_VERSION, scriptPath);
      if (result.updated) {
        log(`updated to ${result.version} — exiting so the service manager restarts the new version`);
        await shutdownWith(0);
      } else if (result.reason && result.reason !== "already up to date") {
        log(`self-update skipped: ${result.reason}`);
      }
    };
    // First check a minute in (don't delay pairing/startup), then every 6 h.
    setTimeout(() => void checkUpdate(), 60_000).unref?.();
    setInterval(() => void checkUpdate(), 6 * 60 * 60 * 1000).unref?.();
  }

  log(`Helio Agent ${AGENT_VERSION} (headless) — server ${config.serverUrl}`);
  if (config.token) {
    startCore();
  } else {
    log("not paired yet — starting the pairing (the code shows below and on the local page)");
    void pairLoop();
  }
}

function cmdAddStick(flags: Record<string, string>): void {
  const ip = (flags.ip ?? "").trim();
  const port = flags.port ? Number(flags.port) : 8899;
  if (!isValidIpv4(ip)) {
    console.error(`"${ip || "(missing --ip)"}" is not a valid IPv4 address`);
    process.exit(1);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`"${flags.port}" is not a valid TCP port`);
    process.exit(1);
  }
  const serial = flags.serial ? Number(flags.serial) : null;
  if (serial !== null && (!Number.isInteger(serial) || serial < 1 || serial > 0xffffffff)) {
    console.error(`"${flags.serial}" is not a valid stick serial`);
    process.exit(1);
  }
  const config = loadConfig();
  config.manualSticks = [...config.manualSticks.filter((s) => s.ip !== ip), { ip, port, serial }];
  saveConfig(config);
  if (!isPrivateIp(ip)) {
    console.warn(
      `Warning: ${ip} is not a private LAN address — the agent will connect out to it ` +
        `over the internet. Only add a device you own (e.g. port-forwarded stick).`,
    );
  }
  console.log(`Stick ${ip}:${port} saved — restart "helio-agent run" to pick it up.`);
}

function cmdRemoveStick(flags: Record<string, string>): void {
  const ip = (flags.ip ?? "").trim();
  const config = loadConfig();
  const next = config.manualSticks.filter((s) => s.ip !== ip);
  if (next.length === config.manualSticks.length) {
    console.error(`No manual stick with IP "${ip || "(missing --ip)"}" — nothing changed.`);
    process.exit(1);
  }
  config.manualSticks = next;
  saveConfig(config);
  console.log(`Stick ${ip} forgotten — restart "helio-agent run" to apply.`);
}

function cmdSignOut(): void {
  const config = loadConfig();
  config.token = null;
  // agentId stays: pairing again later reuses this machine's identity.
  saveConfig(config);
  console.log("Token forgotten. Also revoke this agent on the website (Account → My agents).");
}

async function main(): Promise<void> {
  const [command = "run", ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "pair":
        await cmdPair(parseFlags(rest));
        break;
      case "run":
        await cmdRun(parseFlags(rest));
        break;
      case "doctor":
        await cmdDoctor();
        break;
      case "status":
        cmdStatus();
        break;
      case "add-stick":
        cmdAddStick(parseFlags(rest));
        break;
      case "remove-stick":
        cmdRemoveStick(parseFlags(rest));
        break;
      case "sign-out":
        cmdSignOut();
        break;
      case "--version":
      case "-v":
        console.log(AGENT_VERSION);
        break;
      default:
        console.log(HELP);
        process.exit(command === "--help" || command === "-h" ? 0 : 1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

void main();
