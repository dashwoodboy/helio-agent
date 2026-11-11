import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewerVersion, parseVersion } from "../src/core/update.js";

describe("update check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses release tags in all the shapes we publish", () => {
    expect(parseVersion("0.1.4")).toEqual([0, 1, 4]);
    expect(parseVersion("v0.1.4")).toEqual([0, 1, 4]);
    expect(parseVersion("agent-v10.2.33")).toEqual([10, 2, 33]);
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });

  it("compares semver numerically, not lexically", () => {
    expect(isNewerVersion("0.1.3", "v0.1.4")).toBe(true);
    expect(isNewerVersion("0.1.3", "0.1.3")).toBe(false);
    expect(isNewerVersion("0.1.4", "0.1.3")).toBe(false);
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(false);
    expect(isNewerVersion("0.1.3", "garbage")).toBe(false);
  });

  it("reports a newer published release and stays quiet otherwise", async () => {
    const respond = (tag: string) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })),
      );

    respond("v0.2.0");
    expect(await checkForUpdate("0.1.3")).toBe("0.2.0");
    respond("v0.1.3");
    expect(await checkForUpdate("0.1.3")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 403 })),
    );
    expect(await checkForUpdate("0.1.3")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await checkForUpdate("0.1.3")).toBeNull();
  });
});
