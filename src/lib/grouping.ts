/**
 * Pure, unit-tested helpers for the display-only groupings the UI layers on top of a
 * `DeckSnapshot` (REQ-4, REQ-9, REQ-10). Nothing here talks to `git-wt` — these functions only
 * ever rearrange `Worktree[]` that the adapter already produced, so the heuristic can evolve
 * (spec Q2) without touching anything that issues real git operations.
 */
import type { Worktree } from "./types";

export interface FeatureGrouping {
  /** The shared identity worktrees were grouped on — currently the branch name. */
  feature: string;
  worktrees: Worktree[];
}

/**
 * v1 cross-repo grouping heuristic (REQ-4, spec Q2): exact branch-name match across *more than
 * one* repo. This is deliberately the simplest thing that could work — worktrunk features are
 * single-repo (spec Non-goals), so branch name is the only identity we can observe today. A
 * manifest-based heuristic can replace this later without touching any caller, since callers only
 * see `FeatureGrouping[]`.
 *
 * Single-repo branches are not "features" for this purpose — they belong in the plain per-repo
 * view (or `IsolatedWorktrees`), not a multi-repo group of one.
 */
export function groupByFeature(worktrees: Worktree[]): FeatureGrouping[] {
  const byBranch = new Map<string, Worktree[]>();
  for (const w of worktrees) {
    const bucket = byBranch.get(w.branch);
    if (bucket) bucket.push(w);
    else byBranch.set(w.branch, [w]);
  }

  const groups: FeatureGrouping[] = [];
  for (const [feature, members] of byBranch) {
    const repos = new Set(members.map((w) => w.repoPath));
    if (repos.size > 1) groups.push({ feature, worktrees: members });
  }

  // Stable, readable ordering — alphabetical by feature name.
  return groups.sort((a, b) => a.feature.localeCompare(b.feature));
}

/**
 * A worktree is "isolated" (REQ-9) when it is not part of a cross-repo feature group — i.e. no
 * other configured repo has a worktree on the same branch. Isolated worktrees must still be
 * visible somewhere (the whole point of REQ-9), so this is the complement of `groupByFeature`
 * over the same input.
 */
export function isIsolated(w: Worktree, allWorktrees: Worktree[]): boolean {
  const sharedRepos = new Set(
    allWorktrees.filter((other) => other.branch === w.branch).map((other) => other.repoPath),
  );
  return sharedRepos.size <= 1;
}

/** REQ-10: filter by repo, branch, or feature (branch doubles as feature identity today). */
export function matchesFilter(w: Worktree, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    w.repo.toLowerCase().includes(q) ||
    w.branch.toLowerCase().includes(q) ||
    w.path.toLowerCase().includes(q)
  );
}
