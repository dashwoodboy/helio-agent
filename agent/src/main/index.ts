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
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { AgentCore, AGENT_VERSION, defaultAgentName, platformName } from "../core/agent.js";
import { isValidIpv4 } from "../core/discovery.js";
import { checkForUpdate, DOWNLOAD_BASE } from "../core/update.js";
import { startPairing, waitForApproval, type PairingCodes } from "../core/pairing.js";
import { parseServerUrl } from "../core/serverUrl.js";
import type { LinkStatus } from "../core/link.js";
import type { StickReport } from "../core/sticks.js";
import { loadConfig, saveConfig, secureStorageAvailable, type AgentConfig } from "./store.js";

export interface UiState {
  view: "signin" | "status";
  status: LinkStatus;
  serverUrl: string;
  agentName: string;
  sticks: StickReport[];
  pairing: { userCode: string; verificationUrl: string } | null;
  pairingError: string | null;
  autostart: boolean;
  secureStorage: boolean;
  version: string;
  /** Newer published version ("0.1.4"), or null when up to date. */
  updateAvailable: string | null;
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
    manualSticks: [],
  };
  let core: AgentCore | null = null;
  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let pairing: PairingCodes | null = null;
  let pairingError: string | null = null;
  let pairingAbort: AbortController | null = null;
  let updateAvailable: string | null = null;

  const state = (): UiState => ({
    view: config.token ? "status" : "signin",
    status: core?.status ?? "idle",
    serverUrl: config.serverUrl,
    agentName: defaultAgentName(),
    sticks: core?.sticks ?? [],
    pairing: pairing
      ? { userCode: pairing.userCode, verificationUrl: pairing.verificationUrl }
      : null,
    pairingError,
    autostart: config.autostart,
    secureStorage: secureStorageAvailable(),
    version: AGENT_VERSION,
    updateAvailable,
  });

  const broadcast = (): void => {
    window?.webContents.send("state", state());
    updateTray();
  };

  // ------------------------------------------------------------- core

  const startCore = (): void => {
    if (!config.token) return;
    core?.stop();
    core = new AgentCore({
      serverUrl: config.serverUrl,
      token: config.token,
      manualSticks: config.manualSticks,
      log: (msg) => console.log(`[agent] ${msg}`),
    });
    core.on("status", (status: LinkStatus) => {
      if (status === "unauthorized") {
        // Token revoked server-side: drop it and show the sign-in view.
        config = { ...config, token: null, agentId: null };
        saveConfig(config);
        void core?.stop();
        core = null;
      }
      broadcast();
    });
    core.on("sticks", broadcast);
    core.start();
  };

  const signOut = async (): Promise<void> => {
    await core?.stop();
    core = null;
    config = { ...config, token: null, agentId: null };
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
        saveConfig(config);
        startCore();
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
    if (process.platform === "linux") {
      const dir = path.join(app.getPath("home"), ".config", "autostart");
      const file = path.join(dir, "helio-agent.desktop");
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          file,
          `[Desktop Entry]\nType=Application\nName=Helio Agent\nExec=${process.execPath}\nX-GNOME-Autostart-enabled=true\n`,
        );
      } else {
        fs.rmSync(file, { force: true });
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
  };

  // ------------------------------------------------------------ update

  const pollForUpdate = async (): Promise<void> => {
    const latest = await checkForUpdate(AGENT_VERSION);
    if (latest && latest !== updateAvailable) {
      updateAvailable = latest;
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

  const downloadInstaller = async (name: string): Promise<string> => {
    const res = await fetch(`${DOWNLOAD_BASE}/${name}`);
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const dest = path.join(app.getPath("temp"), name);
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest));
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
    if (!name) throw new Error("Download the new version from the website for this install");
    const file = await downloadInstaller(name);
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
            config = { ...config, autostart: item.checked };
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
    config = { ...config, autostart: Boolean(enabled) };
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
  ipcMain.handle("install-update", async (): Promise<string | null> => {
    try {
      await installUpdate();
      return null;
    } catch (err) {
      quitting = false;
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
  // Packaged builds get the icon from the bundle; set it for dev runs too.
  if (!app.isPackaged && process.platform === "darwin") {
    void app.dock?.setIcon(path.join(resourcesPath(), "icon.png"));
  }
  config = loadConfig();
  createTray();
  createWindow();
  if (config.token) startCore();

  void pollForUpdate();
  setInterval(() => void pollForUpdate(), 6 * 60 * 60 * 1000);
}
