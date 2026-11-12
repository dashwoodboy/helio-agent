/**
 * Tiny local status page for the headless agent (Raspberry Pi image, NAS):
 * plain node:http, zero dependencies, embedded in the CLI bundle.
 *
 * Shows the pairing code with an "Open Helio to approve" button, the link
 * status with its reason, the sticks discovery found, an on-demand
 * connection check (preflight) and the recent log. Strictly read-only: it
 * never exposes the token and accepts no mutations — the pairing itself is
 * driven by `run` (see cli/index.ts), this page only displays it.
 *
 * Security model (documented, accepted): before pairing, anyone on the same
 * LAN could open the page and approve the code into their own account. The
 * window is short (codes last 10 minutes), requires LAN presence, and the
 * page stops showing codes the moment the device is paired. The Host header
 * is validated (localhost, IPs, *.local, single-label names only) so a
 * malicious website can't reach us via DNS rebinding; there are no CORS
 * headers, so browsers block cross-origin reads too.
 */
import http from "node:http";
import net from "node:net";
import type { LinkStatusDetail } from "../core/link.js";
import type { PreflightStep } from "../core/net.js";

export interface LocalUiState {
  version: string;
  serverUrl: string;
  name: string;
  paired: boolean;
  /** Current pairing code, when unpaired and a code is active. */
  pairing: { userCode: string; verificationUrl: string; expiresAt: number } | null;
  pairingError: string | null;
  statusDetail: LinkStatusDetail;
  sticks: { serial: number | null; ip: string; reachable: boolean; manual: boolean }[];
  discoveryIssue: string | null;
  /** Recent log lines (already timestamped), oldest first. */
  logLines: string[];
}

export interface LocalUiOptions {
  /** Preferred port; EACCES/EADDRINUSE fall back to `fallbackPort`. */
  port?: number;
  fallbackPort?: number;
  getState: () => LocalUiState;
  runPreflight: () => Promise<PreflightStep[]>;
  log?: (msg: string) => void;
}

/** Only local names: no public DNS name may resolve to this server. */
export function hostHeaderAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) host = bracketed[1];
  else host = host.replace(/:\d+$/, "");
  if (host === "" ) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (net.isIP(host) !== 0) return true;
  // Single-label hostnames ("helio-agent", a router's DHCP name): local.
  if (!host.includes(".")) return true;
  return false;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  online: "Connected to Helio",
  offline: "Reconnecting…",
  unauthorized: "Signed out",
  replaced: "Another agent instance took over",
  update_required: "Update required",
};

/** The page itself: server-rendered HTML + a dash of inline JS that polls. */
function renderPage(state: LocalUiState): string {
  const d = state.statusDetail;
  const statusLabel = STATUS_LABEL[d.status] ?? d.status;
  const okDot = (ok: boolean) => `<span class="dot ${ok ? "ok" : "bad"}"></span>`;

  const pairingSection = state.paired
    ? ""
    : state.pairing
      ? `<section>
          <h2>Pair this device</h2>
          <p>Approve this code on the Helio website (any phone or computer):</p>
          <div class="code">${esc(state.pairing.userCode)}</div>
          <p><a class="btn" href="${esc(state.pairing.verificationUrl)}" target="_blank" rel="noopener">Open Helio to approve</a></p>
          <p class="muted">The code renews automatically when it expires. Only approve codes you can see on this page.</p>
        </section>`
      : `<section>
          <h2>Pair this device</h2>
          <p class="muted">${esc(state.pairingError ?? "Requesting a pairing code…")} </p>
        </section>`;

  const sticksSection = `
    <section>
      <h2>Sticks on this network</h2>
      ${
        state.sticks.length === 0
          ? `<p class="muted">${esc(
              state.discoveryIssue === "no-private-interface"
                ? "No local network detected — connect this device to the inverter's network."
                : state.discoveryIssue
                  ? `Nothing found (${state.discoveryIssue}).`
                  : "Nothing found yet — the scan repeats every 30 seconds.",
            )}</p>`
          : `<ul>${state.sticks
              .map(
                (s) =>
                  `<li>${okDot(s.reachable)} <strong>${s.serial ?? "Serial unknown"}</strong> <span class="muted">${esc(
                    s.ip,
                  )}${s.manual ? " · added by IP" : ""}</span></li>`,
              )
              .join("")}</ul>`
      }
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Helio Agent — ${esc(state.name)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; background:#0d1117; color:#e6edf3; max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 1.25rem; margin: 0; } h2 { font-size: 1rem; margin: 0 0 8px; }
  header { display:flex; align-items:baseline; gap:10px; margin-bottom: 8px; }
  section { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px; margin-top:16px; }
  .muted { color:#8b949e; font-size:.85rem; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }
  .ok { background:#3fb950; } .bad { background:#f85149; }
  .code { font: 700 2rem/1 ui-monospace, monospace; letter-spacing:.2em; background:#0d1117; border:1px dashed #30363d; border-radius:8px; padding:14px; text-align:center; margin:10px 0; }
  .btn { display:inline-block; background:#238636; color:#fff; text-decoration:none; padding:8px 14px; border-radius:8px; font-weight:600; border:0; font-size:.95rem; cursor:pointer; }
  button.btn { background:#21262d; border:1px solid #30363d; }
  pre { background:#0d1117; border:1px solid #30363d; border-radius:8px; padding:10px; font-size:.75rem; overflow:auto; max-height: 260px; white-space: pre-wrap; }
  ul { list-style:none; padding:0; margin:0; } li { padding:4px 0; }
</style>
</head>
<body>
<header><h1>☀ Helio Agent</h1><span class="muted">v${esc(state.version)} · ${esc(state.name)}</span></header>
<p class="muted">Server: ${esc(state.serverUrl)}</p>

${pairingSection}

<section>
  <h2>Connection</h2>
  <p>${okDot(d.status === "online")} <strong>${esc(statusLabel)}</strong></p>
  ${d.message ? `<p class="muted">${esc(d.message)}</p>` : ""}
  ${d.nextRetryAt && d.status !== "online" ? `<p class="muted">Next attempt: <span id="retry" data-at="${d.nextRetryAt}"></span></p>` : ""}
  <p><button class="btn" id="preflightBtn">Check connection</button></p>
  <div id="preflight"></div>
</section>

${sticksSection}

<section>
  <h2>Recent log</h2>
  <pre>${esc(state.logLines.slice(-100).join("\n")) || "—"}</pre>
</section>

<script>
  // Poll for fresh state: full reload keeps this page dependency-free.
  setTimeout(function () { location.reload(); }, 5000);
  var retry = document.getElementById("retry");
  if (retry) {
    var at = Number(retry.getAttribute("data-at"));
    var tick = function () {
      retry.textContent = Math.max(0, Math.ceil((at - Date.now()) / 1000)) + "s";
    };
    tick(); setInterval(tick, 1000);
  }
  document.getElementById("preflightBtn").addEventListener("click", function () {
    var el = document.getElementById("preflight");
    el.innerHTML = '<p class="muted">Checking…</p>';
    fetch("/api/preflight").then(function (r) { return r.json(); }).then(function (steps) {
      el.innerHTML = "<ul>" + steps.map(function (s) {
        return "<li><span class=\\"dot " + (s.ok ? "ok" : "bad") + "\\"></span><strong>" +
          s.label + "</strong> <span class=\\"muted\\">" + s.detail + "</span></li>";
      }).join("") + "</ul>";
    }).catch(function () { el.innerHTML = '<p class="muted">Check failed.</p>'; });
  });
</script>
</body>
</html>`;
}

export interface LocalUiHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startLocalUi(opts: LocalUiOptions): Promise<LocalUiHandle> {
  const log = opts.log ?? (() => {});
  // One preflight at a time; concurrent page clicks share the result.
  let preflightInFlight: Promise<PreflightStep[]> | null = null;

  const server = http.createServer((req, res) => {
    if (!hostHeaderAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden host");
      return;
    }
    const url = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("read-only");
      return;
    }
    if (url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(opts.getState()));
      return;
    }
    if (url === "/api/preflight") {
      preflightInFlight ??= opts.runPreflight().finally(() => {
        preflightInFlight = null;
      });
      preflightInFlight
        .then((steps) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(steps));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      return;
    }
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(opts.getState()));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once("error", onError);
      server.listen(port, () => {
        server.off("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });

  const preferred = opts.port ?? 80;
  const fallback = opts.fallbackPort ?? 8080;
  let port: number;
  try {
    port = await listen(preferred);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (preferred !== fallback && (code === "EACCES" || code === "EADDRINUSE")) {
      log(`local page: port ${preferred} unavailable (${code}), using ${fallback}`);
      port = await listen(fallback);
    } else {
      throw err;
    }
  }
  log(`local status page on http://localhost:${port} (LAN access via this device's address)`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Don't let open keep-alive sockets delay shutdown.
        server.closeAllConnections?.();
      }),
  };
}
