import { describe, expect, it } from "vitest";

import basic from "../../test/fixtures/list.basic.json";
import full from "../../test/fixtures/list.full.json";
import malformed from "../../test/fixtures/list.malformed.json";
import unreadable from "../../test/fixtures/list.unreadable.json";
import { allWorktrees, toDeckSnapshot, toRepoResult } from "./adapter";
import type { RawRepoResult, RawSnapshot } from "./ipc";

/** Wraps a fixture's rows the way `list_worktrees` would deliver them. */
function okRepo(rows: unknown[], repo = "demo-app"): RawRepoResult {
  return {
    repo,
    repoPath: `C:/repos/${repo}`,
    load: "ok",
    worktrees: rows,
  };
}

function snapshot(...repos: RawRepoResult[]): RawSnapshot {
  return { repos, generatedAt: 1_782_553_568_000 };
}

describe("toRepoResult — real worktrunk output", () => {
  const result = toRepoResult(okRepo(basic));

  it("keeps every worktree in the fixture", () => {
    expect(result.load).toBe("ok");
    expect(result.worktrees).toHaveLength(3);
  });

  it("prefers worktrunk's repo.name over the directory name", () => {
    expect(toRepoResult(okRepo(basic, "some-other-folder")).repo).toBe("demo-app");
  });

  it("maps the main worktree", () => {
    const main = result.worktrees[0]!;
    expect(main.branch).toBe("main");
    expect(main.isMain).toBe(true);
    expect(main.head.shortSha).toBe("5a120fd");
    expect(main.head.message).toMatch(/workout-modal/);
    expect(main.url).toBe("http://localhost:12107");
  });

  it("treats edits to tracked files as dirty and carries the diff counts", () => {
    const main = result.worktrees[0]!;
    expect(main.git).toBe("dirty");
    expect(main.diff).toEqual({ added: 363, deleted: 66 });
  });

  /**
   * The third fixture worktree has untracked files and nothing else — the case that made the
   * old two-state indicator misleading, since it reported "dirty" for a worktree where nothing
   * committed had been touched.
   */
  it("reports untracked-only worktrees as untracked, not dirty", () => {
    const nested = result.worktrees[2]!;
    expect(nested.changes).toEqual({
      staged: false,
      modified: false,
      untracked: true,
      renamed: false,
      deleted: false,
    });
    expect(nested.git).toBe("untracked");
  });

  it("exposes the individual flags so the UI can name what is present", () => {
    expect(result.worktrees[0]!.changes).toEqual({
      staged: false,
      modified: true,
      untracked: true,
      renamed: false,
      deleted: false,
    });
  });

  it("counts any tracked change as dirty, even alongside untracked files", () => {
    const cases = [
      { staged: true },
      { modified: true },
      { renamed: true },
      { deleted: true },
    ];
    for (const tracked of cases) {
      const [w] = toRepoResult(
        okRepo([
          {
            branch: "feat/x",
            path: "C:/repos/demo-app.feat-x",
            working_tree: { untracked: true, ...tracked },
          },
        ]),
      ).worktrees;
      expect(w!.git).toBe("dirty");
    }
  });

  it("is clean only when nothing at all is present", () => {
    const [w] = toRepoResult(
      okRepo([
        {
          branch: "feat/x",
          path: "C:/repos/demo-app.feat-x",
          working_tree: {
            staged: false,
            modified: false,
            untracked: false,
            renamed: false,
            deleted: false,
          },
        },
      ]),
    ).worktrees;
    expect(w!.git).toBe("clean");
  });

  it("defaults `main` ahead/behind to 0/0 when worktrunk omits it (the main worktree)", () => {
    expect(result.worktrees[0]!.main).toEqual({ ahead: 0, behind: 0 });
  });

  it("distinguishes 'no upstream' (null) from 'in sync with upstream' (0/0)", () => {
    // Row 0 tracks origin/main; row 1 is a feature branch that was never pushed.
    expect(result.worktrees[0]!.remote).toEqual({ ahead: 0, behind: 0 });
    expect(result.worktrees[1]!.remote).toBeNull();
  });

  it("passes ahead/behind vs main through", () => {
    const nested = result.worktrees[2]!;
    expect(nested.main).toEqual({ ahead: 0, behind: 267 });
  });

  it("reads url_active for the one listening dev server", () => {
    expect(result.worktrees.map((w) => w.urlActive)).toEqual([false, true, false]);
  });

  it("stamps every worktree with its owning repo so actions know their -C target", () => {
    for (const w of result.worktrees) {
      expect(w.repo).toBe("demo-app");
      expect(w.repoPath).toBe("C:/repos/demo-app");
    }
  });

  it("produces the same result for the --full variant", () => {
    expect(toRepoResult(okRepo(full))).toEqual(result);
  });
});

describe("toRepoResult — unreadable repo (REQ-15)", () => {
  const result = toRepoResult(unreadable as RawRepoResult);

  it("keeps the load state and worktrunk's own error text", () => {
    expect(result.load).toBe("unreadable");
    expect(result.error).toMatch(/git rev-parse/);
    expect(result.worktrees).toEqual([]);
  });

  it("falls back to a readable message when the backend sent no error", () => {
    const bare = toRepoResult({
      repo: "x",
      repoPath: "C:/repos/x",
      load: "unreadable",
      worktrees: [],
    });
    expect(bare.error).toBeTruthy();
  });
});

describe("toRepoResult — malformed rows must degrade, never throw (spec Q3)", () => {
  it("does not throw", () => {
    expect(() => toRepoResult(okRepo(malformed))).not.toThrow();
  });

  const result = toRepoResult(okRepo(malformed));

  it("drops null, non-object and branch-less rows", () => {
    // The fixture has 6 entries; 2 are unusable rows (branch-less object, plus null/string).
    expect(result.worktrees.map((w) => w.branch)).toEqual([
      "feat/ok",
      "feat/no-commit-object",
      "feat/unknown-future-fields",
    ]);
  });

  it("coerces wrong-typed fields to safe values instead of propagating them", () => {
    const bad = result.worktrees[1]!;
    expect(bad.main).toEqual({ ahead: 0, behind: 0 }); // "many" / null
    expect(bad.url).toBeNull(); // a number, not a URL
    expect(bad.urlActive).toBe(false); // the string "true"
    expect(bad.git).toBe("clean"); // modified: "yes-please" is not a boolean
    expect(bad.head).toEqual({ shortSha: "", message: "", timestamp: 0 });
  });

  it("keeps rows that carry unknown future fields (forward compatibility)", () => {
    const future = result.worktrees[2]!;
    expect(future.git).toBe("dirty");
    expect(future.main).toEqual({ ahead: 2, behind: 0 });
    expect(future.urlActive).toBe(true);
    expect(future.url).toBe("http://localhost:12222");
  });
});

describe("toDeckSnapshot", () => {
  it("counts running dev servers across all repos", () => {
    const snap = toDeckSnapshot(snapshot(okRepo(basic), okRepo(malformed, "other")));
    expect(snap.runningCount).toBe(2); // one per fixture
    expect(snap.generatedAt).toBe(1_782_553_568_000);
  });

  it("does not let an unreadable repo remove the others (REQ-15)", () => {
    const snap = toDeckSnapshot(
      snapshot(unreadable as RawRepoResult, okRepo(basic)),
    );
    expect(snap.repos).toHaveLength(2);
    expect(snap.repos[0]!.load).toBe("unreadable");
    expect(allWorktrees(snap)).toHaveLength(3);
  });

  it("handles an empty configuration", () => {
    const snap = toDeckSnapshot(snapshot());
    expect(snap.repos).toEqual([]);
    expect(snap.runningCount).toBe(0);
  });
});
