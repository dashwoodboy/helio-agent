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
  /** Resolves to an error message, or null on success. */
  addManualStick: (ip: string, port: number, serial: number | null) => Promise<string | null>;
  removeManualStick: (ip: string) => Promise<void>;
  /** Resolves to an error message, or null on success. */
  setStickSerial: (ip: string, serial: number) => Promise<string | null>;
  /** Downloads and runs the new installer; resolves to an error message, or null. */
  installUpdate: () => Promise<string | null>;
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
  addManualStick: (ip, port, serial) => ipcRenderer.invoke("add-manual-stick", ip, port, serial),
  removeManualStick: (ip) => ipcRenderer.invoke("remove-manual-stick", ip),
  setStickSerial: (ip, serial) => ipcRenderer.invoke("set-stick-serial", ip, serial),
  installUpdate: () => ipcRenderer.invoke("install-update"),
};

contextBridge.exposeInMainWorld("helio", bridge);
