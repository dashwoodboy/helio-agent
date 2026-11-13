/**
 * Token-free diagnostic report. Users paste this into a support email or
 * the feedback form; it must contain everything needed to debug "it says
 * connected but no data" — and never a credential.
 */
import os from "node:os";
import type { LinkStatusDetail } from "./link.js";
import type { PreflightStep } from "./net.js";
import type { StickReport } from "./sticks.js";

export interface StatusHistoryEntry extends LinkStatusDetail {
  /** ISO timestamp of when the agent entered this state. */
  at: string;
}

/**
 * Strip anything token-shaped, wherever it may have leaked into a message.
 * (The agent never logs tokens on purpose; this is the safety net.)
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/hat_[0-9a-f]{8,}/gi, "hat_[redacted]")
    .replace(/(authorization\s*:?\s*bearer\s+)\S+/gi, "$1[redacted]");
}

export interface DiagnosticsInput {
  version: string;
  platform: string;
  serverUrl: string;
  paired: boolean;
  status: LinkStatusDetail;
  statusHistory: StatusHistoryEntry[];
  sticks: StickReport[];
  discoveryIssue: string | null;
  logLines: string[];
  preflight: PreflightStep[] | null;
}

export function buildDiagnosticReport(input: DiagnosticsInput): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("=== Helio Agent diagnostics ===");
  push(`Generated: ${new Date().toISOString()}`);
  push(`Agent version: ${input.version}`);
  push(`Platform: ${input.platform} (${os.type()} ${os.release()}, ${os.arch()})`);
  push(`Server: ${input.serverUrl}`);
  push(`Paired: ${input.paired ? "yes" : "no"}`);
  push();

  push("--- Connection status ---");
  push(
    `Now: ${input.status.status}` +
      (input.status.code !== null ? ` (code ${input.status.code})` : "") +
      (input.status.message ? ` — ${input.status.message}` : ""),
  );
  if (input.statusHistory.length > 0) {
    push("History (newest last):");
    for (const h of input.statusHistory) {
      push(
        `  ${h.at} ${h.status}` +
          (h.code !== null ? ` (${h.code})` : "") +
          (h.message ? ` — ${h.message}` : ""),
      );
    }
  }
  push();

  push("--- Sticks ---");
  if (input.sticks.length === 0) {
    push(`none visible${input.discoveryIssue ? ` (issue: ${input.discoveryIssue})` : ""}`);
  } else {
    for (const s of input.sticks) {
      push(
        `  ${s.serial ?? "serial unknown"} @ ${s.ip}` +
          `${s.mac ? ` (${s.mac})` : ""}` +
          ` — ${s.reachable ? "reachable" : "unreachable"}${s.manual ? ", manual" : ""}`,
      );
    }
    if (input.discoveryIssue) push(`  discovery issue: ${input.discoveryIssue}`);
  }
  push();

  if (input.preflight) {
    push("--- Connection check (preflight) ---");
    for (const step of input.preflight) {
      push(`  [${step.ok ? "ok" : "FAIL"}] ${step.label}: ${step.detail}`);
    }
    push();
  }

  push(`--- Recent log (${input.logLines.length} lines) ---`);
  for (const line of input.logLines) push(line);

  return redactSecrets(lines.join("\n"));
}
