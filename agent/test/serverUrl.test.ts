/** The agent's TLS-only URL policy — the security boundary for all uplink traffic. */
import { describe, expect, it } from "vitest";
import { isLoopbackHost, parseServerUrl } from "../src/core/serverUrl.js";

describe("server URL policy", () => {
  it("accepts https and derives the wss agent URL", () => {
    expect(parseServerUrl("https://helio-power.eu")).toEqual({
      baseUrl: "https://helio-power.eu",
      agentWsUrl: "wss://helio-power.eu/ws/agent",
      insecureLoopback: false,
    });
  });

  it("bare domains default to https, never http", () => {
    const parsed = parseServerUrl("helio-power.eu");
    expect(parsed.baseUrl).toBe("https://helio-power.eu");
    expect(parsed.agentWsUrl).toBe("wss://helio-power.eu/ws/agent");
  });

  it("keeps ports and path prefixes, strips trailing slashes", () => {
    expect(parseServerUrl("https://example.com:9003/helio/")).toEqual({
      baseUrl: "https://example.com:9003/helio",
      agentWsUrl: "wss://example.com:9003/helio/ws/agent",
      insecureLoopback: false,
    });
  });

  it("rejects plain http for anything that is not loopback", () => {
    expect(() => parseServerUrl("http://helio-power.eu")).toThrow(/only allowed for localhost/);
    expect(() => parseServerUrl("http://192.168.1.10:3001")).toThrow(/only allowed for localhost/);
  });

  it("allows plain http for loopback (development)", () => {
    const parsed = parseServerUrl("http://localhost:3001");
    expect(parsed).toEqual({
      baseUrl: "http://localhost:3001",
      agentWsUrl: "ws://localhost:3001/ws/agent",
      insecureLoopback: true,
    });
    expect(parseServerUrl("http://127.0.0.1:3001").insecureLoopback).toBe(true);
  });

  it("rejects other schemes and embedded credentials", () => {
    expect(() => parseServerUrl("ftp://example.com")).toThrow(/Only https/);
    expect(() => parseServerUrl("file:///etc/passwd")).toThrow();
    expect(() => parseServerUrl("https://user:pass@example.com")).toThrow(/Credentials/);
    expect(() => parseServerUrl("")).toThrow();
    expect(() => parseServerUrl("not a url")).toThrow();
  });

  it("knows loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});
