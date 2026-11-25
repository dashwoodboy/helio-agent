/** Start-at-login decisions: the legacy-config migration and the OS read-back. */
import { describe, expect, it } from "vitest";
import {
  describeLoginItemIssue,
  resolveAutostartConfigured,
  shouldDefaultAutostartOn,
} from "../src/core/autostart.js";

describe("resolveAutostartConfigured", () => {
  it("treats an old stored `autostart: false` as never decided", () => {
    // Agents up to 0.1.6 always wrote this, whatever the user did.
    expect(resolveAutostartConfigured({ autostart: false })).toBe(false);
  });

  it("treats a fresh config as never decided", () => {
    expect(resolveAutostartConfigured({})).toBe(false);
  });

  it("treats an old stored `autostart: true` as a decision (the toggle was used)", () => {
    expect(resolveAutostartConfigured({ autostart: true })).toBe(true);
  });

  it("trusts the explicit marker over the stored value", () => {
    expect(resolveAutostartConfigured({ autostart: false, autostartConfigured: true })).toBe(true);
    expect(resolveAutostartConfigured({ autostart: true, autostartConfigured: false })).toBe(false);
  });
});

describe("shouldDefaultAutostartOn", () => {
  it("switches on for a paired install that never decided", () => {
    expect(shouldDefaultAutostartOn({ token: "t", autostartConfigured: false })).toBe(true);
  });

  it("never overrides an explicit choice, including off", () => {
    expect(shouldDefaultAutostartOn({ token: "t", autostartConfigured: true })).toBe(false);
  });

  it("waits for pairing when there is no token yet (the pairing flow applies the default)", () => {
    expect(shouldDefaultAutostartOn({ token: null, autostartConfigured: false })).toBe(false);
  });
});

describe("describeLoginItemIssue", () => {
  it("reports nothing when autostart is off", () => {
    expect(
      describeLoginItemIssue("darwin", false, { openAtLogin: false, status: "not-registered" }),
    ).toBeNull();
  });

  it("reports nothing once macOS enabled the item", () => {
    expect(
      describeLoginItemIssue("darwin", true, { openAtLogin: true, status: "enabled" }),
    ).toBeNull();
  });

  it("points at Login Items when macOS waits for approval", () => {
    expect(
      describeLoginItemIssue("darwin", true, { openAtLogin: false, status: "requires-approval" }),
    ).toMatch(/Login Items/);
  });

  it("explains a not-found item and a plain refusal on macOS", () => {
    expect(
      describeLoginItemIssue("darwin", true, { openAtLogin: false, status: "not-found" }),
    ).toMatch(/Applications folder/);
    expect(
      describeLoginItemIssue("darwin", true, { openAtLogin: false, status: "not-registered" }),
    ).toMatch(/did not accept/);
  });

  it("flags a refused login item on Windows, accepts a registered one", () => {
    expect(describeLoginItemIssue("win32", true, { openAtLogin: false })).not.toBeNull();
    expect(describeLoginItemIssue("win32", true, { openAtLogin: true })).toBeNull();
  });
});
