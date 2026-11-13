/**
 * Self-update for the headless CLI (helio-agent-cli.cjs). The Pi image and
 * the Linux installer are "write once" — nobody re-flashes a card for a bug
 * fix — so the running bundle replaces itself from the GitHub release:
 *
 *   1. Ask the releases API for the latest version (same check the desktop
 *      app uses); nothing newer → done.
 *   2. Download `helio-agent-cli.cjs`, its `.sha256` and its `.sig`.
 *   3. Verify the sha256 AND the ed25519 signature against the public key
 *      embedded below (the private key only exists in the repository's
 *      AGENT_SIGNING_KEY secret — see scripts/sign-cli.mjs). A compromised
 *      download host or release upload therefore can't push code here.
 *   4. Write next to the running file and rename over it (atomic on POSIX),
 *      then tell the caller to exit so systemd restarts the new version.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkForUpdate } from "../core/update.js";
import { fetchWithTimeout } from "../core/net.js";

/** Matches the key in the AGENT_SIGNING_KEY repository secret. */
export const SELF_UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtf0pRyasc93Y0uKNf2HMaSAsAhYluCJ7ogA4bUidQsk=
-----END PUBLIC KEY-----
`;

export const CLI_ASSET = "helio-agent-cli.cjs";

export interface SelfUpdateResult {
  /** True when the file on disk was replaced — restart to run it. */
  updated: boolean;
  version?: string;
  reason?: string;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Verify both checks; returns null when good, else the failure reason. */
export function verifyBundle(
  bundle: Buffer,
  sha256Hex: string,
  signatureB64: string,
  publicKeyPem: string = SELF_UPDATE_PUBLIC_KEY_PEM,
): string | null {
  const actual = crypto.createHash("sha256").update(bundle).digest("hex");
  if (actual !== sha256Hex.trim().toLowerCase()) {
    return `sha256 mismatch (expected ${sha256Hex.trim()}, got ${actual})`;
  }
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      bundle,
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureB64.trim(), "base64"),
    );
  } catch (err) {
    return `signature check failed: ${(err as Error).message}`;
  }
  return ok ? null : "ed25519 signature does not match";
}

/**
 * Check, verify and swap. `scriptPath` is the running bundle
 * (process.argv[1]). Never throws: all failures come back as
 * `{updated:false, reason}` so the agent keeps running on the old version.
 */
export async function selfUpdate(
  currentVersion: string,
  scriptPath: string,
): Promise<SelfUpdateResult> {
  try {
    const update = await checkForUpdate(currentVersion);
    if (!update) return { updated: false, reason: "already up to date" };

    const bundleUrl = update.assets[CLI_ASSET];
    const shaUrl = update.assets[`${CLI_ASSET}.sha256`];
    const sigUrl = update.assets[`${CLI_ASSET}.sig`];
    if (!bundleUrl || !shaUrl || !sigUrl) {
      return {
        updated: false,
        reason: `release ${update.version} is missing the CLI bundle, its .sha256 or its .sig`,
      };
    }

    const [bundle, sha, sig] = await Promise.all([
      download(bundleUrl),
      download(shaUrl),
      download(sigUrl),
    ]);
    // The .sha256 is "<hex>  <filename>" (shasum format) or bare hex.
    const shaHex = sha.toString("utf8").trim().split(/\s+/)[0];
    const bad = verifyBundle(bundle, shaHex, sig.toString("utf8"));
    if (bad) return { updated: false, reason: `refusing ${update.version}: ${bad}` };

    // Atomic swap: write beside the target, then rename over it.
    const target = fs.realpathSync(scriptPath);
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.new`);
    fs.writeFileSync(tmp, bundle, { mode: 0o755 });
    fs.renameSync(tmp, target);
    return { updated: true, version: update.version };
  } catch (err) {
    return { updated: false, reason: (err as Error).message };
  }
}
