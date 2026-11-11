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
import { AgentCore, AGENT_VERSION, defaultAgentName } from "../core/agent.js";
import { isPrivateIp, isValidIpv4 } from "../core/discovery.js";
import { startPairing, waitForApproval } from "../core/pairing.js";
import { parseServerUrl } from "../core/serverUrl.js";
import type { LinkStatus } from "../core/link.js";

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
  };
}

function saveConfig(config: CliConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function readCa(config: CliConfig): Buffer | undefined {
  if (!config.caFile) return undefined;
  return fs.readFileSync(config.caFile);
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
  helio-agent run
      Run the agent (foreground). Use a service manager to keep it running:

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
  helio-agent sign-out
      Forget the stored token (also revoke the agent on the website).

The token is stored with 0600 permissions in
~/.config/helio-agent/config.json. Only https:// servers are accepted
(plain http solely for localhost); certificate verification is never
disabled — --ca adds a private CA on top of the system store.
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

  const codes = await startPairing(config.serverUrl, { name: config.name, platform: "linux" });
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

async function cmdRun(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.error("Not paired yet — run: helio-agent pair");
    process.exit(1);
  }

  const core = new AgentCore({
    serverUrl: config.serverUrl,
    token: config.token,
    name: config.name,
    ca: readCa(config),
    manualSticks: config.manualSticks,
    log,
  });

  core.on("status", (status: LinkStatus) => {
    log(`status: ${status}`);
    if (status === "unauthorized") {
      console.error("The server rejected the token (revoked?) — run pair again.");
      void core.stop().then(() => process.exit(1));
    }
    if (status === "replaced") {
      console.error("Another instance of this agent connected and took over.");
      void core.stop().then(() => process.exit(1));
    }
  });
  core.on("sticks", (sticks: { serial: number | null; ip: string }[]) => {
    log(
      sticks.length === 0
        ? "no sticks visible on this network"
        : `sticks: ${sticks.map((s) => `${s.serial ?? "serial unknown"}@${s.ip}`).join(", ")}`,
    );
  });

  const shutdown = (signal: string) => {
    log(`${signal} received, stopping`);
    void core.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log(`Helio Agent ${AGENT_VERSION} (headless) — server ${config.serverUrl}`);
  core.start();
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
  config.agentId = null;
  saveConfig(config);
  console.log("Token forgotten. Also revoke this agent on the website (Settings → Data source).");
}

async function main(): Promise<void> {
  const [command = "run", ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "pair":
        await cmdPair(parseFlags(rest));
        break;
      case "run":
        await cmdRun();
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
