/**
 * The app version lives in `package.json` (the source of truth, which `tauri.conf.json` points
 * at) and again in `src-tauri/Cargo.toml`, which is a crate manifest and cannot reference JSON.
 *
 * Two copies can drift, and the symptom is horrible to diagnose: bundle filenames say one
 * version while `cargo` metadata says another. `pnpm bump` writes both; this test makes sure
 * nobody has hand-edited one and forgotten the other.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SEMVER = /^\d+\.\d+\.\d+$/;

function packageVersion(): string {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

function cargoVersion(): string {
  const toml = readFileSync("src-tauri/Cargo.toml", "utf8");
  // Anchored to the [package] table so a dependency's version cannot match by accident.
  const match = toml.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error("no [package] version found in src-tauri/Cargo.toml");
  return match[1];
}

describe("app version", () => {
  it("is a plain semver in package.json", () => {
    expect(packageVersion()).toMatch(SEMVER);
  });

  it("matches between package.json and Cargo.toml", () => {
    expect(cargoVersion()).toBe(packageVersion());
  });

  it("is sourced from package.json by tauri.conf.json, not duplicated a third time", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    // A literal version here would be a third copy to keep in sync — the whole point is that
    // Tauri resolves it from package.json instead.
    expect(conf.version).toBe("../package.json");
  });
});
