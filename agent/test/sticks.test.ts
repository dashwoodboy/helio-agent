/** StickRegistry: manually pinned sticks (added by IP + port). */
import { describe, expect, it } from "vitest";
import { StickRegistry } from "../src/core/sticks.js";

describe("manual sticks", () => {
  it("pins a manual stick: listed as unreachable until a probe marks it seen", () => {
    const reg = new StickRegistry();
    expect(reg.addManual("192.168.1.137", 8899)).toBe(true);

    expect(reg.report()).toEqual([
      { serial: null, ip: "192.168.1.137", mac: null, reachable: false, manual: true },
    ]);

    reg.markManualSeen("192.168.1.137");
    expect(reg.report()[0].reachable).toBe(true);
    expect(reg.manualEntries()).toEqual([{ ip: "192.168.1.137", port: 8899 }]);
  });

  it("never expires manual entries on update(), unlike discovered ones", () => {
    const reg = new StickRegistry();
    reg.addManual("10.0.0.5", 9000);
    // Rounds that do not see the stick must keep it listed (just unreachable).
    reg.update([]);
    reg.update([]);
    expect(reg.report()).toHaveLength(1);
    expect(reg.report()[0]).toMatchObject({ ip: "10.0.0.5", manual: true });
  });

  it("merges a UDP discovery reply into the manual entry (serial learned, still pinned)", () => {
    const reg = new StickRegistry();
    reg.addManual("192.168.1.137", 8899);
    reg.update([{ ip: "192.168.1.137", mac: "AA", serial: 2712345678 }]);

    expect(reg.report()).toEqual([
      { serial: 2712345678, ip: "192.168.1.137", mac: "AA", reachable: true, manual: true },
    ]);
    // The manual port survives the merge (discovery replies carry no port).
    expect(reg.manualEntries()).toEqual([{ ip: "192.168.1.137", port: 8899 }]);
  });

  it("removeManual() only removes pinned entries", () => {
    const reg = new StickRegistry();
    reg.update([{ ip: "192.168.1.20", mac: null, serial: 2700000001 }]);
    reg.addManual("192.168.1.137");

    expect(reg.removeManual("192.168.1.20")).toBe(false); // discovered, not manual
    expect(reg.removeManual("192.168.1.137")).toBe(true);
    expect(reg.report().map((s) => s.ip)).toEqual(["192.168.1.20"]);
  });

  it("accepts public addresses (the UI warns) but rejects invalid input", () => {
    const reg = new StickRegistry();
    // A port-forwarded stick on a public IP is allowed — the user typed it.
    expect(reg.addManual("203.0.113.5", 8899)).toBe(true);
    expect(reg.report()[0]).toMatchObject({ ip: "203.0.113.5", manual: true });

    expect(() => reg.addManual("999.1.1.1")).toThrow(/IPv4/);
    expect(() => reg.addManual("not-an-ip")).toThrow(/IPv4/);
    expect(() => reg.addManual("192.168.1.137", 0)).toThrow(/port/);
    expect(() => reg.addManual("192.168.1.137", 70000)).toThrow(/port/);
  });
});
