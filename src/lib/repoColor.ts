/**
 * Deterministic per-repo colour so repos are visually distinguishable at a glance (user request).
 *
 * Hashes the repo *path*, not the display name — two repos can share a display name (e.g. a
 * monorepo checked out twice under different config labels), but the path is what uniquely
 * identifies a repo across the whole deck (see `keyOf` in App.tsx).
 */
import type { CSSProperties } from "react";

/**
 * FNV-1a: small, dependency-free, and stable across processes/platforms — unlike
 * `Array.prototype.reduce`-based hashes seeded from `String.charCodeAt`, it avoids clustering
 * for the kind of near-identical paths repos tend to have (e.g. sibling worktree directories).
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic per-repo hue so a repo keeps its colour across refreshes and restarts. */
export function repoHue(repoPath: string): number {
  return hashString(repoPath) % 360;
}

/**
 * Inline style object for a card/section tint — must be subtle (NFR-7: a tint must never hurt
 * text contrast). Very low chroma + alpha means the underlying `--card`/`--background` colour
 * always dominates, so it reads correctly layered over either theme's base colour without a
 * separate light/dark branch.
 */
export function repoTintStyle(repoPath: string): CSSProperties {
  const hue = repoHue(repoPath);
  return { backgroundColor: `oklch(0.6 0.04 ${hue} / 0.06)` };
}

/** A stronger version for the repo header accent dot / swatch. */
export function repoAccentStyle(repoPath: string): CSSProperties {
  const hue = repoHue(repoPath);
  return { backgroundColor: `oklch(0.6 0.14 ${hue} / 0.7)` };
}

/**
 * The same accent as a left border. Separate from {@link repoAccentStyle} because a border and
 * a fill need different CSS properties — reusing the fill would silently do nothing.
 */
export function repoAccentBorder(repoPath: string): CSSProperties {
  const hue = repoHue(repoPath);
  return { borderLeftColor: `oklch(0.6 0.14 ${hue} / 0.55)` };
}
