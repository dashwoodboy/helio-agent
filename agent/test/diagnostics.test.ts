/** Ring/file logging and the token-free diagnostic report. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDiagnosticReport, redactSecrets } from "../src/core/diagnostics.js";
import { AgentLogger } from "../src/core/logging.js";

describe("AgentLogger", () => {
  it("keeps only the newest lines in the ring", () => {
    const logger = new AgentLogger({ capacity: 3 });
    for (let i = 1; i <= 5; i++) logger.log(`line ${i}`);
    const lines = logger.lines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("line 3");
    expect(lines[2]).toContain("line 5");
  });

  it("writes to the file and rotates it when it grows past the cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helio-log-"));
    const file = path.join(dir, "agent.log");
    const logger = new AgentLogger({ file, maxFileBytes: 200 });
    for (let i = 0; i < 20; i++) logger.log(`a fairly long log line number ${i}`);

    expect(fs.existsSync(`${file}.1`)).toBe(true); // rotated at least once
    const current = fs.existsSync(file) ? fs.statSync(file).size : 0;
    expect(current).toBeLessThanOrEqual(300);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a broken log path never throws — the ring keeps working", () => {
    const logger = new AgentLogger({ file: "/dev/null/not-a-dir/agent.log" });
    expect(() => logger.log("still fine")).not.toThrow();
    expect(logger.lines()[0]).toContain("still fine");
  });
});

describe("diagnostic report", () => {
  it("redacts anything token-shaped", () => {
    const dirty = `connecting with hat_${"a".repeat(64)} and Authorization: Bearer abc.def-123`;
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("a".repeat(20));
    expect(clean).toContain("hat_[redacted]");
    expect(clean).toMatch(/Bearer\s+\[redacted\]/i);
  });

  it("contains the sections support needs and never the token", () => {
    const token = `hat_${"b".repeat(64)}`;
    const report = buildDiagnosticReport({
      version: "0.2.0",
      platform: "macos",
      serverUrl: "https://helio-power.eu",
      paired: true,
      status: { status: "offline", code: 1006, message: "Connection lost.", nextRetryAt: null },
      statusHistory: [
        { at: "2026-11-11T10:00:00Z", status: "online", code: null, message: "", nextRetryAt: null },
      ],
      sticks: [
        { serial: 2712345678, ip: "192.168.1.50", mac: "AA", reachable: true, manual: false },
      ],
      discoveryIssue: null,
      logLines: [`2026-11-11T10:00:01Z sent ${token} by mistake`],
      preflight: [
        { id: "dns", label: "Find the server (DNS)", ok: true, detail: "ok" },
        { id: "tls", label: "Secure connection (TLS)", ok: false, detail: "antivirus" },
      ],
    });

    expect(report).toContain("Agent version: 0.2.0");
    expect(report).toContain("offline");
    expect(report).toContain("2712345678");
    expect(report).toContain("[FAIL] Secure connection (TLS)");
    expect(report).not.toContain(token);
    expect(report).toContain("hat_[redacted]");
  });
});
