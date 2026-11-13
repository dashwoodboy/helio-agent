/**
 * Helio Agent — Electron main process.
 *
 * Hardening: single instance, outbound connections only, contextIsolation +
 * sandbox on, navigation blocked, external links restricted to https on the
 * configured server. The window hides to the tray on close.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  net as electronNet,
  powerMonitor,
  session,
  shell,
  Tray,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import tls from "node:tls";
import type { Agent as HttpAgent } from "node:http";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AgentCore, AGENT_VERSION, defaultAgentName, platformName } from "../core/agent.js";
import { buildDiagnosticReport, type StatusHistoryEntry } from "../core/diagnostics.js";
import { isValidIpv4 } from "../core/discovery.js";
import { AgentLogger } from "../core/logging.js";
import {
  getDefaultFetch,
  preflight,
  setDefaultFetch,
  type FetchImpl,
  type PreflightStep,
} from "../core/net.js";
import { describeLoginItemIssue, shouldDefaultAutostartOn } from "../core/autostart.js";
import { checkForUpdate } from "../core/update.js";
import { startPairing, waitForApproval, type PairingCodes } from "../core/pairing.js";
import { parseServerUrl } from "../core/serverUrl.js";
import type { LinkStatus, LinkStatusDetail } from "../core/link.js";
import type { StickReport } from "../core/sticks.js";
import { loadConfig, saveConfig, secureStorageAvailable, type AgentConfig } from "./store.js";

/**
 * Trust the OS certificate store for Node's own TLS (the `ws` uplink).
 * Antivirus suites and company proxies that inspect HTTPS install their CA
 * in the OS store; without this, the uplink fails with a certificate error
 * while the browser works — the most confusing failure users hit.
 * Feature-detected: present in the Node bundled with Electron ≥ 34 roughly.
 */
function trustSystemCertificates(): void {
  try {
    const t = tls as unknown as {
      getCACertificates?: (type?: string) => string[];
      setDefaultCACertificates?: (certs: string[]) => void;
    };
    if (!t.getCACertificates || !t.setDefaultCACertificates) return;
    const bundled = t.getCACertificates("default");
    const system = t.getCACertificates("system");
    if (system.length > 0) {
      t.setDefaultCACertificates([...new Set([...bundled, ...system])]);
    }
  } catch {
    // Never fatal: the bundled Mozilla roots keep working as before.
  }
}

/**
 * The HTTP agent for the WebSocket uplink when the OS says this URL goes
 * through a proxy (Chromium's resolver — PAC files included). `ws` ignores
 * OS proxies by itself, so corporate networks need this.
 */
async function resolveWsAgent(serverUrl: string): Promise<HttpAgent | undefined> {
  try {
    const { agentWsUrl } = parseServerUrl(serverUrl);
    const probeUrl = agentWsUrl.replace(/^ws/, "http");
    const resolved = await session.defaultSession.resolveProxy(probeUrl);
    const match = resolved.match(/(?:PROXY|HTTPS)\s+([^;\s]+)/i);
    if (!match) return undefined; // DIRECT
    return new HttpsProxyAgent(`http://${match[1]}`) as unknown as HttpAgent;
  } catch {
    return undefined;
  }
}

export interface UiState {
  view: "signin" | "status";
  status: LinkStatus;
  /** Status with reason, close code and next retry time. */
  statusDetail: LinkStatusDetail;
  /** Why discovery found nothing (OS/permission causes), when it knows. */
  discoveryIssue: string | null;
  /** "windows" | "macos" | "linux" — for platform-specific hints. */
  platform: string;
  /** True right after pairing until the user confirms the next step. */
  justPaired: boolean;
  serverUrl: string;
  agentName: string;
  sticks: StickReport[];
  pairing: { userCode: string; verificationUrl: string } | null;
  pairingError: string | null;
  autostart: boolean;
  /** Why the OS did not accept the login item (e.g. macOS approval needed), or null. */
  autostartIssue: string | null;
  secureStorage: boolean;
  version: string;
  /** Newer published version ("0.1.4"), or null when up to date. */
  updateAvailable: string | null;
  /** Progress of an in-flight update download, or null when idle. */
  updateDownload: { received: number; total: number | null } | null;
}

// Brand the app even when running unpackaged (dev/preview), where Electron's
// own name and icon would otherwise show up in the dock and task bar.
app.setName("Helio Agent");
app.setAppUserModelId("eu.helio-power.agent");

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  let config: AgentConfig = {
    serverUrl: "",
    token: null,
    agentId: null,
    autostart: false,
    autostartConfigured: false,
    manualSticks: [],
    knownSticks: [],
  };
  let core: AgentCore | null = null;
  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  // 500-line ring for the diagnostic report + rotating file in userData.
  const logger = new AgentLogger({
    file: path.join(app.getPath("userData"), "logs", "helio-agent.log"),
  });
  const log = (msg: string): void => {
    console.log(`[agent] ${msg}`);
    logger.log(msg);
  };
  const statusHistory: StatusHistoryEntry[] = [];
  let quitting = false;
  let pairing: PairingCodes | null = null;
  let pairingError: string | null = null;
  let pairingAbort: AbortController | null = null;
  let updateAvailable: string | null = null;
  let updateUrl: string | null = null;
  let updateDownload: { received: number; total: number | null } | null = null;
  let justPaired = false;
  let autostartIssue: string | null = null;

  const state = (): UiState => ({
    view: config.token ? "status" : "signin",
    status: core?.status ?? "idle",
    statusDetail:
      core?.statusDetail ?? { status: "idle", code: null, message: "", nextRetryAt: null },
    discoveryIssue: core?.discoveryIssue ?? null,
    platform: platformName(),
    justPaired,
    serverUrl: config.serverUrl,
    agentName: defaultAgentName(),
    sticks: core?.sticks ?? [],
    pairing: pairing
      ? { userCode: pairing.userCode, verificationUrl: pairing.verificationUrl }
      : null,
    pairingError,
    autostart: config.autostart,
    autostartIssue,
    secureStorage: secureStorageAvailable(),
    version: AGENT_VERSION,
    updateAvailable,
    updateDownload,
  });

  const broadcast = (): void => {
    window?.webContents.send("state", state());
    updateTray();
  };

  // ------------------------------------------------------------- core

  const startCore = async (): Promise<void> => {
    if (!config.token) return;
    await core?.stop();
    core = new AgentCore({
      serverUrl: config.serverUrl,
      token: config.token,
      manualSticks: config.manualSticks,
      knownSticks: config.knownSticks,
      wsAgent: await resolveWsAgent(config.serverUrl),
      log,
    });
    core.on("status", (detail: LinkStatusDetail) => {
      statusHistory.push({ ...detail, at: new Date().toISOString() });
      if (statusHistory.length > 50) statusHistory.splice(0, statusHistory.length - 50);
      log(
        `status: ${detail.status}` +
          (detail.code !== null ? ` (${detail.code})` : "") +
          (detail.message ? ` — ${detail.message}` : ""),
      );
      if (detail.status === "unauthorized") {
        // Token dead server-side: drop it and show the sign-in view. The
        // agentId is kept — re-pairing sends it as previousAgentId so the
        // server keeps this device's identity and its environments.
        config = { ...config, token: null };
        saveConfig(config);
        void core?.stop();
        core = null;
      }
      broadcast();
    });
    core.on("sticks", () => {
      // Remember what discovery saw: the next start probes these directly,
      // so a stick whose firmware ignores UDP comes back without user help.
      const seen = (core?.sticks ?? [])
        .filter((s) => !s.manual && s.reachable)
        .map((s) => ({ ip: s.ip, serial: s.serial }));
      if (JSON.stringify(seen) !== JSON.stringify(config.knownSticks)) {
        config = { ...config, knownSticks: seen };
        saveConfig(config);
      }
      broadcast();
    });
    core.start();
  };

  const signOut = async (): Promise<void> => {
    await core?.stop();
    core = null;
    // The agentId stays: pairing again later reuses this device's identity.
    config = { ...config, token: null };
    saveConfig(config);
    broadcast();
  };

  // ---------------------------------------------------------- pairing

  const beginPairing = async (serverUrl: string): Promise<void> => {
    pairingError = null;
    try {
      parseServerUrl(serverUrl); // throws with a friendly message
      config = { ...config, serverUrl: parseServerUrl(serverUrl).baseUrl };
      saveConfig(config);
      pairing = await startPairing(config.serverUrl, {
        name: defaultAgentName(),
        platform: platformName(),
        // Re-pairing keeps this device's identity (and its environments).
        previousAgentId: config.agentId,
      });
      broadcast();
      void shell.openExternal(pairing.verificationUrl);

      pairingAbort = new AbortController();
      const outcome = await waitForApproval(config.serverUrl, pairing, {
        signal: pairingAbort.signal,
      });
      pairing = null;
      if (outcome.status === "approved") {
        config = { ...config, token: outcome.token, agentId: outcome.agentId };
        // Relaying data needs the agent running: start at login by default
        // after the first pairing (the Settings toggle can turn it off).
        if (!config.autostartConfigured) {
          config = { ...config, autostart: true, autostartConfigured: true };
          applyAutostart(true);
        }
        saveConfig(config);
        justPaired = true;
        void startCore();
      } else if (outcome.status === "denied") {
        pairingError = "The request was denied on the website.";
      } else {
        pairingError = "The code expired — try again.";
      }
    } catch (err) {
      pairing = null;
      pairingError = (err as Error).message;
    }
    broadcast();
  };

  // --------------------------------------------------------- autostart

  const applyAutostart = (enabled: boolean): void => {
    try {
      if (process.platform === "linux") {
        const dir = path.join(app.getPath("home"), ".config", "autostart");
        const file = path.join(dir, "helio-agent.desktop");
        if (enabled) {
          // An AppImage runs from a temporary mount; only the .AppImage file
          // itself survives a reboot.
          const exec = process.env.APPIMAGE ?? process.execPath;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            file,
            `[Desktop Entry]\nType=Application\nName=Helio Agent\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`,
          );
        } else {
          fs.rmSync(file, { force: true });
        }
        autostartIssue = null;
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled });
        // Ask the OS what it actually registered: an unsigned macOS build can
        // be left waiting for the user's approval under Login Items.
        const login = app.getLoginItemSettings();
        autostartIssue = describeLoginItemIssue(process.platform, enabled, login);
        log(
          `autostart ${enabled ? "on" : "off"}: openAtLogin=${login.openAtLogin}` +
            (process.platform === "darwin" ? ` status=${login.status}` : "") +
            (autostartIssue ? ` — ${autostartIssue}` : ""),
        );
      }
    } catch (err) {
      autostartIssue = `Could not change the start-at-login setting: ${(err as Error).message}`;
      log(`autostart failed: ${(err as Error).message}`);
    }
  };

  // ------------------------------------------------------------ update

  const pollForUpdate = async (): Promise<void> => {
    const info = await checkForUpdate(AGENT_VERSION);
    if (!info) return;
    // Only announce the update once this platform's installer has actually
    // been uploaded — right after a release is tagged, CI is still building
    // and "Update now" would hit a 404.
    const name = installerAsset();
    const url = name ? (info.assets[name] ?? null) : null;
    if (name && !url) return;
    if (info.version !== updateAvailable) {
      updateAvailable = info.version;
      updateUrl = url;
      broadcast();
    }
  };

  /** The installer this platform updates with, or null (dev run, unknown OS). */
  const installerAsset = (): string | null => {
    if (!app.isPackaged) return null;
    if (process.platform === "win32") return "HelioAgent-Setup.exe";
    if (process.platform === "darwin") return "HelioAgent.dmg";
    if (process.platform === "linux") {
      return process.env.APPIMAGE ? "HelioAgent.AppImage" : "HelioAgent.deb";
    }
    return null;
  };

  const downloadInstaller = async (name: string, url: string): Promise<string> => {
    // Chromium's fetch (OS proxy + OS trust store); no timeout — downloads
    // are long-lived and report their own progress.
    const res = await getDefaultFetch()(url);
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || null;
    let received = 0;
    let lastBroadcast = 0;
    updateDownload = { received: 0, total };
    broadcast();
    // Counts bytes as they stream to disk so the banner can show progress.
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        const now = Date.now();
        if (now - lastBroadcast >= 150) {
          lastBroadcast = now;
          updateDownload = { received, total };
          broadcast();
        }
        done(null, chunk);
      },
    });
    const dest = path.join(app.getPath("temp"), name);
    try {
      await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(dest));
    } catch (err) {
      updateDownload = null;
      broadcast();
      throw err;
    }
    updateDownload = { received, total };
    broadcast();
    return dest;
  };

  /**
   * Builds are unsigned, so Squirrel-style in-place updates are out on
   * macOS. Each platform gets the closest thing to one click:
   * - Windows: run the downloaded one-click installer — it replaces the app
   *   and relaunches it by itself.
   * - Linux AppImage: overwrite the running image and relaunch.
   * - macOS (and .deb installs): open the downloaded installer and quit so
   *   the user can replace the app.
   */
  const installUpdate = async (): Promise<void> => {
    const name = installerAsset();
    if (!name || !updateUrl) {
      throw new Error("Download the new version from the website for this install");
    }
    const file = await downloadInstaller(name, updateUrl);
    quitting = true;
    if (process.platform === "win32") {
      spawn(file, [], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "linux" && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      fs.rmSync(target, { force: true }); // unlink works while running
      fs.copyFileSync(file, target);
      fs.chmodSync(target, 0o755);
      app.relaunch({ execPath: target });
    } else {
      await shell.openPath(file);
    }
    app.quit();
  };

  // ------------------------------------------------------- window/tray

  const resourcesPath = (): string =>
    app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), "resources");

  const createWindow = (): void => {
    window = new BrowserWindow({
      width: 460,
      height: 640,
      resizable: false,
      icon: path.join(resourcesPath(), "icon.png"),
      title: "Helio Agent",
      backgroundColor: "#0c111c",
      webPreferences: {
        preload: path.join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenuBarVisibility(false);

    // Outbound hardening: no navigation, no popups; external links only to
    // https (the pairing page on the configured server).
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith(config.serverUrl)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    window.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        window?.hide();
      }
    });
    window.on("closed", () => (window = null));

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
    }
  };

  const showWindow = (): void => {
    if (window) {
      window.show();
      window.focus();
    } else {
      createWindow();
    }
  };

  const updateTray = (): void => {
    if (!tray) return;
    const online = core?.status === "online";
    tray.setToolTip(`Helio Agent — ${online ? "connected" : "not connected"}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: online ? "Connected to Helio" : "Not connected", enabled: false },
        ...(updateAvailable
          ? [
              {
                label: `Update to v${updateAvailable}…`,
                click: () => void installUpdate().catch(showWindow),
              },
            ]
          : []),
        { type: "separator" },
        { label: "Open Helio Agent", click: showWindow },
        {
          label: "Open Helio website",
          click: () => void shell.openExternal(config.serverUrl || "https://helio-power.eu"),
        },
        { type: "separator" },
        {
          label: "Start at login",
          type: "checkbox",
          checked: config.autostart,
          click: (item) => {
            config = { ...config, autostart: item.checked, autostartConfigured: true };
            saveConfig(config);
            applyAutostart(item.checked);
            broadcast();
          },
        },
        { type: "separator" },
        {
          label: "Quit Helio Agent",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };

  const createTray = (): void => {
    const image = nativeImage
      .createFromPath(path.join(resourcesPath(), "tray.png"))
      .resize({ width: 18, height: 18 });
    image.setTemplateImage(process.platform === "darwin");
    tray = new Tray(image);
    tray.on("click", () => {
      if (process.platform !== "darwin") showWindow();
    });
    updateTray();
  };

  // --------------------------------------------------------------- IPC

  ipcMain.handle("state", () => state());
  ipcMain.handle("start-pairing", (_e, serverUrl: string) => void beginPairing(String(serverUrl)));
  ipcMain.handle("cancel-pairing", () => {
    pairingAbort?.abort();
    pairing = null;
    pairingError = null;
    broadcast();
  });
  ipcMain.handle("open-verification", () => {
    if (pairing) void shell.openExternal(pairing.verificationUrl);
  });
  ipcMain.handle("sign-out", () => void signOut());
  ipcMain.handle("set-autostart", (_e, enabled: boolean) => {
    config = { ...config, autostart: Boolean(enabled), autostartConfigured: true };
    saveConfig(config);
    applyAutostart(config.autostart);
    broadcast();
  });
  ipcMain.handle("rescan", async () => {
    await core?.runDiscovery();
    broadcast();
  });
  ipcMain.handle(
    "add-manual-stick",
    async (_e, ip: string, port: number, serial?: number | null): Promise<string | null> => {
      try {
        const cleanIp = String(ip).trim();
        const cleanPort = Number(port) || 8899;
        const cleanSerial = serial ? Number(serial) : null;
        if (!isValidIpv4(cleanIp)) throw new Error(`"${cleanIp}" is not a valid IPv4 address`);
        await core?.addManualStick(cleanIp, cleanPort, cleanSerial);
        config = {
          ...config,
          manualSticks: [
            ...config.manualSticks.filter((s) => s.ip !== cleanIp),
            { ip: cleanIp, port: cleanPort, serial: cleanSerial },
          ],
        };
        saveConfig(config);
        broadcast();
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
  );
  ipcMain.handle("remove-manual-stick", (_e, ip: string) => {
    core?.removeManualStick(String(ip));
    config = { ...config, manualSticks: config.manualSticks.filter((s) => s.ip !== String(ip)) };
    saveConfig(config);
    broadcast();
  });
  ipcMain.handle("reconnect-now", async () => {
    core?.reconnectNow();
    await core?.runDiscovery();
    broadcast();
  });
  ipcMain.handle("check-connection", async (): Promise<PreflightStep[]> => {
    if (!config.serverUrl) return [];
    return preflight(config.serverUrl).catch(() => []);
  });
  ipcMain.handle("dismiss-just-paired", () => {
    justPaired = false;
    broadcast();
  });
  ipcMain.handle("open-wizard", () => {
    const base = config.serverUrl || "https://helio-power.eu";
    void shell.openExternal(`${base}/environments/new`);
  });
  ipcMain.handle("open-network-settings", () => {
    // macOS Local Network privacy pane — the usual culprit when discovery
    // finds nothing (the OS silently drops LAN packets until allowed).
    if (process.platform === "darwin") {
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
      );
    }
  });
  ipcMain.handle("open-login-items-settings", () => {
    // macOS 13+: System Settings → General → Login Items.
    if (process.platform === "darwin") {
      void shell.openExternal("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
    }
  });
  ipcMain.handle("copy-diagnostics", async (): Promise<string | null> => {
    try {
      // The preflight contacts the server (bogus token, no credentials) so
      // the report can say exactly which network step is broken.
      const flight = config.serverUrl
        ? await preflight(config.serverUrl).catch(() => null)
        : null;
      const report = buildDiagnosticReport({
        version: AGENT_VERSION,
        platform: platformName(),
        serverUrl: config.serverUrl,
        paired: Boolean(config.token),
        status: core?.statusDetail ?? { status: "idle", code: null, message: "", nextRetryAt: null },
        statusHistory,
        sticks: core?.sticks ?? [],
        discoveryIssue: core?.discoveryIssue ?? null,
        logLines: logger.lines(),
        preflight: flight,
      });
      clipboard.writeText(report);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  ipcMain.handle("install-update", async (): Promise<string | null> => {
    try {
      await installUpdate();
      return null;
    } catch (err) {
      quitting = false;
      updateDownload = null;
      broadcast();
      return (err as Error).message;
    }
  });
  ipcMain.handle("set-stick-serial", (_e, ip: string, serial: number): string | null => {
    try {
      const cleanIp = String(ip).trim();
      const cleanSerial = Number(serial);
      core?.setStickSerial(cleanIp, cleanSerial);
      // Manual sticks keep the serial across restarts.
      config = {
        ...config,
        manualSticks: config.manualSticks.map((s) =>
          s.ip === cleanIp ? { ...s, serial: cleanSerial } : s,
        ),
      };
      saveConfig(config);
      broadcast();
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  // -------------------------------------------------------------- boot

  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    void core?.stop();
  });
  app.on("window-all-closed", () => {
    // Keep running in the tray on every platform.
  });

  await app.whenReady();
  // HTTP(S) requests (pairing, update checks, preflight) go through
  // Chromium's stack: OS certificate store and OS proxy settings, like the
  // user's browser. Node's TLS additionally trusts the system store for ws.
  setDefaultFetch(electronNet.fetch.bind(electronNet) as unknown as FetchImpl);
  trustSystemCertificates();
  // Packaged builds get the icon from the bundle; set it for dev runs too.
  if (!app.isPackaged && process.platform === "darwin") {
    void app.dock?.setIcon(path.join(resourcesPath(), "icon.png"));
  }
  config = loadConfig();

  // An install that paired before the default-on shipped has autostart stored
  // as "off" without the user ever choosing it: turn it on, once. An explicit
  // choice (toggle or tray item) sets autostartConfigured and is never undone.
  if (shouldDefaultAutostartOn(config)) {
    config = { ...config, autostart: true, autostartConfigured: true };
    saveConfig(config);
    log("autostart: switched on by default (paired install with no saved choice)");
  }
  // Register on every launch, not just at the toggle: this heals a login item
  // the OS dropped or one that points at a moved app. Dev runs are skipped —
  // they would register the Electron dev binary instead of the installed app.
  if (config.autostart && app.isPackaged) applyAutostart(true);

  createTray();
  createWindow();
  if (config.token) void startCore();

  // Waking from sleep leaves a half-open socket and possibly a new network;
  // don't wait for the watchdog — reconnect and rescan immediately.
  powerMonitor.on("resume", () => {
    log("system resumed: reconnecting and rescanning");
    core?.reconnectNow();
    void core?.runDiscovery();
  });

  // Wi-Fi switch, VPN up/down, cable plugged: the interface signature
  // changes. React like a resume (10 s cadence is plenty).
  let netSignature = JSON.stringify(os.networkInterfaces());
  setInterval(() => {
    const current = JSON.stringify(os.networkInterfaces());
    if (current === netSignature) return;
    netSignature = current;
    log("network interfaces changed: reconnecting and rescanning");
    core?.reconnectNow();
    void core?.runDiscovery();
  }, 10_000).unref?.();

  void pollForUpdate();
  setInterval(() => void pollForUpdate(), 6 * 60 * 60 * 1000);
}
