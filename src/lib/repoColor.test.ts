import { describe, expect, it } from "vitest";

import { repoAccentStyle, repoHue, repoTintStyle } from "./repoColor";

describe("repoHue", () => {
  it("is deterministic for the same path", () => {
    const path = "C:/repos/demo-app";
    expect(repoHue(path)).toBe(repoHue(path));
  });

  it("stays within a valid hue range", () => {
    const hue = repoHue("C:/repos/demo-app");
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it("generally differs across different paths", () => {
    const paths = [
      "C:/repos/app-a",
      "C:/repos/app-b",
      "C:/repos/app-c",
      "C:/repos/app-d",
      "C:/repos/app-e",
      "C:/repos/service-x",
      "C:/repos/service-y",
    ];
    const hues = new Set(paths.map(repoHue));
    // Not a strict guarantee for any hash, but a real spread should produce more than one bucket.
    expect(hues.size).toBeGreaterThan(1);
  });

  it("does not collide on display name — only the path matters", () => {
    // Two distinct repo paths that happen to share a display name must still get their own hue
    // whenever the paths themselves differ (this is the whole point of hashing the path).
    const a = repoHue("C:/repos/monorepo-copy-1");
    const b = repoHue("C:/repos/monorepo-copy-2");
    expect(a).not.toBe(b);
  });
});

describe("repoTintStyle / repoAccentStyle", () => {
  it("returns defined styles", () => {
    const tint = repoTintStyle("C:/repos/demo-app");
    const accent = repoAccentStyle("C:/repos/demo-app");
    expect(tint).toBeDefined();
    expect(tint.backgroundColor).toBeDefined();
    expect(accent).toBeDefined();
    expect(accent.backgroundColor).toBeDefined();
  });

  it("is deterministic across calls", () => {
    const path = "C:/repos/demo-app";
    expect(repoTintStyle(path)).toEqual(repoTintStyle(path));
    expect(repoAccentStyle(path)).toEqual(repoAccentStyle(path));
  });
});
