/**
 * Update check against the public GitHub releases of the agent.
 *
 * The app is unsigned, so the classic in-place auto-update (Squirrel) is not
 * available on macOS. Instead the agent downloads the right installer itself:
 * Windows runs the one-click installer, Linux swaps the AppImage in place,
 * macOS opens the dmg for the user to drag into Applications.
 */
import { fetchWithTimeout } from "./net.js";

export const UPDATE_REPO = "dashwoodboy/helio-agent";
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

export interface UpdateInfo {
  /** Normalized version of the latest release, e.g. "0.1.6". */
  version: string;
  /** Download URLs of the installers already uploaded, keyed by file name. */
  assets: Record<string, string>;
}

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
 * Returns the latest published release (version + installer download URLs)
 * when it is newer than `currentVersion`, else null. The check always targets
 * the newest release, so intermediate versions are skipped (0.1.4 → 0.1.6
 * directly). Network errors resolve to null — the next periodic check retries.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetchWithTimeout(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tag_name?: unknown;
      assets?: { name?: unknown; browser_download_url?: unknown }[];
    };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!isNewerVersion(currentVersion, tag)) return null;
    const parsed = parseVersion(tag);
    if (!parsed) return null;
    const assets: Record<string, string> = {};
    for (const a of Array.isArray(body.assets) ? body.assets : []) {
      if (typeof a?.name === "string" && typeof a?.browser_download_url === "string") {
        assets[a.name] = a.browser_download_url;
      }
    }
    return { version: parsed.join("."), assets };
  } catch {
    return null;
  }
}
