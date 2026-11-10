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
import { AgentCore, AGENT_VERSION, defaultAgentName, platformName } from "../core/agent.js";
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
  let config: AgentConfig = { serverUrl: "", token: null, agentId: null, autostart: false };
  let core: AgentCore | null = null;
  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let pairing: PairingCodes | null = null;
  let pairingError: string | null = null;
  let pairingAbort: AbortController | null = null;

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
}
