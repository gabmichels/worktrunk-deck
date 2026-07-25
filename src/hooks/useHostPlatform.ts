/**
 * The host OS, for wording that differs per platform ("Open in Explorer" vs "Finder").
 *
 * Cached module-side: the value cannot change while the app runs, and several components ask
 * for it, so there is no reason to pay for a round trip per mount.
 */
import { useEffect, useState } from "react";

import { hostPlatform } from "@/lib/ipc";

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

export function useHostPlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(cached);

  useEffect(() => {
    if (cached !== null) return;
    let alive = true;
    inFlight ??= hostPlatform();
    void inFlight
      .then((p) => {
        cached = p;
        if (alive) setPlatform(p);
      })
      .catch(() => {
        // Not fatal — callers fall back to neutral wording.
      });
    return () => {
      alive = false;
    };
  }, []);

  return platform;
}

/** "Open in Explorer" / "Open in Finder" / a neutral fallback while unknown. */
export function fileManagerLabel(platform: string | null): string {
  if (platform === "windows") return "Open in Explorer";
  if (platform === "macos") return "Open in Finder";
  return "Open in file manager";
}
