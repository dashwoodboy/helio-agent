/**
 * Update check against the public GitHub releases of the agent.
 *
 * The app is unsigned, so the classic in-place auto-update (Squirrel) is not
 * available on macOS. Instead the agent downloads the right installer itself:
 * Windows runs the one-click installer, Linux swaps the AppImage in place,
 * macOS opens the dmg for the user to drag into Applications.
 */

export const UPDATE_REPO = "dashwoodboy/helio-agent";
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const DOWNLOAD_BASE = `https://github.com/${UPDATE_REPO}/releases/latest/download`;

/** "v0.1.4" / "agent-v0.1.4" / "0.1.4" → [0, 1, 4]; null when malformed. */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = String(tag)
    .trim()
    .match(/(\d+)\.(\d+)\.(\d+)\s*$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

/**
 * Returns the latest published version ("0.1.4") when it is newer than
 * `currentVersion`, else null. Network errors resolve to null — the next
 * periodic check retries.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!isNewerVersion(currentVersion, tag)) return null;
    const parsed = parseVersion(tag);
    return parsed ? parsed.join(".") : null;
  } catch {
    return null;
  }
}
