import { describe, expect, it } from "vitest";

import { groupStatus, totalChanges } from "./gitStatus";
import type { StatusEntry } from "./types";

function entry(index: string, worktree: string, path: string, originalPath?: string): StatusEntry {
  return { index, worktree, path, ...(originalPath ? { originalPath } : {}) };
}

describe("groupStatus", () => {
  it("puts index changes in staged and working-tree changes in unstaged", () => {
    const grouped = groupStatus([
      entry("M", " ", "staged.txt"),
      entry(" ", "M", "edited.txt"),
    ]);

    expect(grouped.staged.map((l) => l.path)).toEqual(["staged.txt"]);
    expect(grouped.unstaged.map((l) => l.path)).toEqual(["edited.txt"]);
    expect(grouped.untracked).toEqual([]);
  });

  /**
   * `MM` is staged *and* edited again since. Showing it in only one group would misrepresent
   * what a commit right now would actually capture.
   */
  it("lists a file that is both staged and further edited in both groups", () => {
    const grouped = groupStatus([entry("M", "M", "both.txt")]);

    expect(grouped.staged.map((l) => l.path)).toEqual(["both.txt"]);
    expect(grouped.unstaged.map((l) => l.path)).toEqual(["both.txt"]);
    expect(totalChanges(grouped)).toBe(2);
  });

  it("treats untracked as its own group, not as an index change", () => {
    const grouped = groupStatus([entry("?", "?", "new.txt")]);

    expect(grouped.untracked.map((l) => l.path)).toEqual(["new.txt"]);
    expect(grouped.staged).toEqual([]);
    expect(grouped.unstaged).toEqual([]);
    expect(grouped.untracked[0]!.kind).toBe("untracked");
  });

  it("names the kind of each change", () => {
    const grouped = groupStatus([
      entry("A", " ", "added.txt"),
      entry("D", " ", "gone.txt"),
      entry(" ", "D", "deleted-locally.txt"),
    ]);

    expect(grouped.staged.map((l) => l.kind)).toEqual(["added", "deleted"]);
    expect(grouped.unstaged.map((l) => l.kind)).toEqual(["deleted"]);
  });

  it("keeps the original path of a rename so the UI can show from → to", () => {
    const grouped = groupStatus([entry("R", " ", "now.txt", "before.txt")]);

    expect(grouped.staged[0]).toEqual({
      path: "now.txt",
      originalPath: "before.txt",
      kind: "renamed",
    });
  });

  /** A conflict cannot be committed as-is, so it belongs where the user must act. */
  it("surfaces merge conflicts as unstaged", () => {
    const grouped = groupStatus([entry("U", "U", "clash.txt")]);

    expect(grouped.unstaged[0]!.kind).toBe("conflicted");
    expect(grouped.staged).toEqual([]);
  });

  it("ignores unchanged sides rather than inventing entries", () => {
    const grouped = groupStatus([entry(" ", " ", "quiet.txt")]);
    expect(totalChanges(grouped)).toBe(0);
  });

  it("handles a clean tree", () => {
    expect(totalChanges(groupStatus([]))).toBe(0);
  });
});
