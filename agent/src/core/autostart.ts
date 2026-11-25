/**
 * Pure decisions around "start when I log in" (no Electron imports, so they
 * are unit-testable).
 */

/**
 * Was autostart ever decided by the user (or by the first-pairing default)?
 *
 * Agents up to 0.1.6 always wrote `autostart: false` to disk without any
 * choice being made, so a stored `false` with no `autostartConfigured` marker
 * means "never decided" — not "the user switched it off". Only a stored `true`
 * (the toggle was used) counts as a decision for those older configs.
 */
export function resolveAutostartConfigured(stored: {
  autostart?: boolean;
  autostartConfigured?: boolean;
}): boolean {
  return stored.autostartConfigured ?? stored.autostart === true;
}

/**
 * An agent that is already paired but never had autostart decided (installs
 * that paired before the default-on shipped) should start at login too —
 * relaying data needs the agent running. The user's own choice is never
 * overridden: `autostartConfigured` is set as soon as the toggle is used.
 */
export function shouldDefaultAutostartOn(config: {
  token: string | null;
  autostartConfigured: boolean;
}): boolean {
  return Boolean(config.token) && !config.autostartConfigured;
}

/** What the OS reports about the registered login item. */
export interface LoginItemReadback {
  openAtLogin: boolean;
  /** macOS 13+ only: the SMAppService status. */
  status?: "not-registered" | "enabled" | "requires-approval" | "not-found";
}

/**
 * A human-readable problem when the OS did not (fully) accept the login item,
 * or null when it is registered. Unsigned macOS builds are the usual source:
 * the OS can ask the user to approve the item under Login Items.
 */
export function describeLoginItemIssue(
  platform: string,
  wanted: boolean,
  login: LoginItemReadback,
): string | null {
  if (!wanted) return null;
  if (platform === "darwin") {
    switch (login.status) {
      case "enabled":
        return null;
      case "requires-approval":
        return "macOS is waiting for your approval. Open System Settings → General → Login Items and switch Helio Agent on.";
      case "not-found":
        return "macOS could not find the app to register it. Move Helio Agent to the Applications folder, then reopen it.";
      default:
        return login.openAtLogin
          ? null
          : "macOS did not accept the login item. Add Helio Agent under System Settings → General → Login Items.";
    }
  }
  return login.openAtLogin ? null : "The system did not accept the start-at-login setting.";
}
