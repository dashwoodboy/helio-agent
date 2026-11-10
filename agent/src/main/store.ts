/**
 * Persisted agent configuration. The token is encrypted with Electron
 * `safeStorage` (Keychain / DPAPI / libsecret). When no OS keyring backend
 * exists (some Linux setups) it falls back to a plain file with 0600
 * permissions and the UI shows a warning (`secureStorage: false`).
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AgentConfig {
  serverUrl: string;
  /** Present after pairing; null when signed out. */
  token: string | null;
  agentId: string | null;
  autostart: boolean;
}

interface StoredShape {
  serverUrl?: string;
  tokenEncrypted?: string; // base64, safeStorage
  tokenPlain?: string; // fallback only
  agentId?: string;
  autostart?: boolean;
}

/** Build-time default (see electron.vite.config.ts `define`). */
declare const __HELIO_SERVER_URL__: string;
export const DEFAULT_SERVER_URL =
  typeof __HELIO_SERVER_URL__ !== "undefined" ? __HELIO_SERVER_URL__ : "https://helio-power.eu";

const FILE = () => path.join(app.getPath("userData"), "agent-config.json");

export function secureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function loadConfig(): AgentConfig {
  let stored: StoredShape = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE(), "utf8")) as StoredShape;
  } catch {
    // first run
  }
  let token: string | null = null;
  if (stored.tokenEncrypted && secureStorageAvailable()) {
    try {
      token = safeStorage.decryptString(Buffer.from(stored.tokenEncrypted, "base64"));
    } catch {
      token = null; // keyring changed; the user pairs again
    }
  } else if (stored.tokenPlain) {
    token = stored.tokenPlain;
  }
  return {
    serverUrl: stored.serverUrl ?? DEFAULT_SERVER_URL,
    token,
    agentId: stored.agentId ?? null,
    autostart: stored.autostart ?? false,
  };
}

export function saveConfig(config: AgentConfig): void {
  const stored: StoredShape = {
    serverUrl: config.serverUrl,
    agentId: config.agentId ?? undefined,
    autostart: config.autostart,
  };
  if (config.token) {
    if (secureStorageAvailable()) {
      stored.tokenEncrypted = safeStorage.encryptString(config.token).toString("base64");
    } else {
      stored.tokenPlain = config.token;
    }
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}
