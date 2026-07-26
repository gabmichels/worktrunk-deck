import { describe, expect, it } from "vitest";

import { groupByFeature, isIsolated, matchesFilter } from "./grouping";
import type { Worktree } from "./types";

function wt(overrides: Partial<Worktree>): Worktree {
  return {
    repo: "demo-app",
    repoPath: "C:/repos/demo-app",
    branch: "feat/x",
    path: "C:/repos/demo-app.feat-x",
    isMain: false,
    git: "clean",
    changes: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
    },
    diff: { added: 0, deleted: 0 },
    main: { ahead: 0, behind: 0 },
    remote: null,
    head: { shortSha: "abc1234", message: "msg", timestamp: 0 },
    url: null,
    urlActive: false,
    ...overrides,
  };
}

describe("groupByFeature", () => {
  it("groups worktrees sharing a branch across more than one repo", () => {
    const a = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/shared" });
    const b = wt({ repo: "app-b", repoPath: "C:/repos/app-b", branch: "feat/shared" });
    const groups = groupByFeature([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.feature).toBe("feat/shared");
    expect(groups[0]!.worktrees).toHaveLength(2);
  });

  it("does not group a branch that exists in only one repo", () => {
    const a = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/solo" });
    expect(groupByFeature([a])).toHaveLength(0);
  });

  it("does not group two worktrees of the same branch within the same repo", () => {
    // Same repoPath twice — should never happen in practice (one worktree per branch per
    // repo) but the heuristic must not double-count a single repo as "cross-repo".
    const a = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/x", path: "/x1" });
    const b = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/x", path: "/x2" });
    expect(groupByFeature([a, b])).toHaveLength(0);
  });

  it("sorts groups alphabetically by feature name", () => {
    const mk = (feature: string, repo: string) =>
      wt({ repo, repoPath: `C:/repos/${repo}`, branch: feature });
    const groups = groupByFeature([
      mk("feat/zeta", "app-a"),
      mk("feat/zeta", "app-b"),
      mk("feat/alpha", "app-a"),
      mk("feat/alpha", "app-b"),
    ]);
    expect(groups.map((g) => g.feature)).toEqual(["feat/alpha", "feat/zeta"]);
  });
});

describe("isIsolated", () => {
  it("is isolated when no other repo shares the branch", () => {
    const a = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/solo" });
    expect(isIsolated(a, [a])).toBe(true);
  });

  it("is not isolated when another repo shares the branch", () => {
    const a = wt({ repo: "app-a", repoPath: "C:/repos/app-a", branch: "feat/shared" });
    const b = wt({ repo: "app-b", repoPath: "C:/repos/app-b", branch: "feat/shared" });
    expect(isIsolated(a, [a, b])).toBe(false);
    expect(isIsolated(b, [a, b])).toBe(false);
  });
});

describe("matchesFilter", () => {
  const w = wt({ repo: "demo-app", branch: "feat/login", path: "C:/repos/demo-app.feat-login" });

  it("matches an empty query", () => {
    expect(matchesFilter(w, "")).toBe(true);
  });

  it("matches by repo name, case-insensitively", () => {
    expect(matchesFilter(w, "DEMO")).toBe(true);
  });

  it("matches by branch name", () => {
    expect(matchesFilter(w, "login")).toBe(true);
  });

  it("matches by path", () => {
    expect(matchesFilter(w, "feat-login")).toBe(true);
  });

  it("does not match unrelated queries", () => {
    expect(matchesFilter(w, "nonexistent")).toBe(false);
  });
});
