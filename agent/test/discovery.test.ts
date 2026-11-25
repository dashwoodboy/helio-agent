/** UDP discovery, reply parsing, and the TCP sweep fallback against a fake stick. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  broadcastAddress,
  discoverDetailed,
  discoverOnce,
  isPrivateIp,
  parseDiscoveryReply,
  tcpSweep,
} from "../src/core/discovery.js";
import { AgentCore } from "../src/core/agent.js";
import { startFakeStick, type FakeStickHandle } from "./fakeStick.js";

const SERIAL = 2712345678;

let stick: FakeStickHandle;

beforeAll(async () => {
  stick = await startFakeStick({ serial: SERIAL });
});

afterAll(async () => {
  await stick?.stop();
});

describe("discovery", () => {
  it("parses IP,MAC,SERIAL replies and rejects malformed ones", () => {
    expect(parseDiscoveryReply("192.168.1.50,AABBCCDDEEFF,2712345678")).toEqual({
      ip: "192.168.1.50",
      mac: "AABBCCDDEEFF",
      serial: 2712345678,
    });
    // Serial missing (older firmware) — stick still listed.
    expect(parseDiscoveryReply("10.0.0.7,AABBCC")).toEqual({
      ip: "10.0.0.7",
      mac: "AABBCC",
      serial: null,
    });
    // Public payload IPs are fine (NATed/port-forwarded sticks); discoverOnce
    // keys results by the actual sender address, so a payload cannot steer us.
    expect(parseDiscoveryReply("203.0.113.5,AABBCC,2712345678")).toMatchObject({
      ip: "203.0.113.5",
      serial: 2712345678,
    });
    expect(parseDiscoveryReply("999.1.2.3,AABBCC")).toBeNull();
    expect(parseDiscoveryReply("garbage")).toBeNull();
  });

  it("computes directed broadcast addresses", () => {
    expect(broadcastAddress("192.168.1.42", "255.255.255.0")).toBe("192.168.1.255");
    expect(broadcastAddress("10.20.30.40", "255.255.0.0")).toBe("10.20.255.255");
  });

  it("classifies private ranges", () => {
    for (const ip of ["10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.9.9", "127.0.0.1", "169.254.1.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "203.0.113.5"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("finds the fake stick over UDP with its serial", async () => {
    const found = await discoverOnce({
      targets: [{ address: "127.0.0.1", port: stick.udpPort }],
      timeoutMs: 1000,
    });
    expect(found).toEqual([{ ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: SERIAL }]);
  });

  it("sticks that omit the serial are reported with serial null", async () => {
    const shy = await startFakeStick({ serial: SERIAL + 1, hideSerial: true });
    try {
      const found = await discoverOnce({
        targets: [{ address: "127.0.0.1", port: shy.udpPort }],
        timeoutMs: 1000,
      });
      expect(found).toEqual([{ ip: "127.0.0.1", mac: "AABBCCDDEEFF", serial: null }]);
    } finally {
      await shy.stop();
    }
  });

  it("reports no-private-interface when there is nothing to probe from", async () => {
    const result = await discoverDetailed({ targets: [], timeoutMs: 300 });
    expect(result).toEqual({ sticks: [], issue: "no-private-interface" });
  });

  it("a remembered stick that ignores UDP is kept reachable by a direct TCP probe", async () => {
    // Discovery targets point somewhere silent (UDP goes unanswered), but
    // the persisted stick still answers TCP on its port — the shape of
    // firmware that ignores the WIFIKIT probe.
    const core = new AgentCore({
      serverUrl: "http://127.0.0.1:1",
      token: "hat_" + "0".repeat(64),
      discoveryTargets: [{ address: "127.0.0.1", port: stick.tcpPort /* silent for UDP */ }],
      tcpFallback: false,
      knownSticks: [{ ip: "127.0.0.1", port: stick.tcpPort, serial: SERIAL }],
    });
    try {
      const sticks = await core.runDiscovery();
      expect(sticks).toEqual([
        { serial: SERIAL, ip: "127.0.0.1", mac: null, reachable: true, manual: false },
      ]);
      expect(core.discoveryIssue).toBeNull();
    } finally {
      await core.stop();
    }
  });

  it("the TCP sweep finds open stick ports and skips closed ones", async () => {
    const open = await tcpSweep({ hosts: ["127.0.0.1"], port: stick.tcpPort, timeoutMs: 500 });
    expect(open).toEqual(["127.0.0.1"]);

    const closed = await tcpSweep({ hosts: ["127.0.0.1"], port: 1, timeoutMs: 300 });
    expect(closed).toEqual([]);

    // Public hosts are never probed.
    const filtered = await tcpSweep({ hosts: ["8.8.8.8"], port: 53, timeoutMs: 300 });
    expect(filtered).toEqual([]);
  });
});
