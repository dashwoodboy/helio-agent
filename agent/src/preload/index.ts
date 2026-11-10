/** Minimal, typed IPC surface — the only thing the sandboxed renderer can reach. */
import { contextBridge, ipcRenderer } from "electron";

export interface HelioBridge {
  getState: () => Promise<unknown>;
  onState: (cb: (state: unknown) => void) => () => void;
  startPairing: (serverUrl: string) => Promise<void>;
  cancelPairing: () => Promise<void>;
  openVerification: () => Promise<void>;
  signOut: () => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<void>;
  rescan: () => Promise<void>;
}

const bridge: HelioBridge = {
  getState: () => ipcRenderer.invoke("state"),
  onState: (cb) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  startPairing: (serverUrl) => ipcRenderer.invoke("start-pairing", serverUrl),
  cancelPairing: () => ipcRenderer.invoke("cancel-pairing"),
  openVerification: () => ipcRenderer.invoke("open-verification"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled),
  rescan: () => ipcRenderer.invoke("rescan"),
};

contextBridge.exposeInMainWorld("helio", bridge);
