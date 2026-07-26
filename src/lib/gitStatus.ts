/**
 * Turns git's two-letter status codes into the groups the detail modal renders.
 *
 * Kept pure and separate from the component because the codes have real subtleties — a file can
 * be staged *and* have further unstaged edits (`MM`), which means it belongs in two groups at
 * once — and getting that wrong is the sort of thing you only notice when you trust the UI and
 * commit the wrong thing.
 */
import type { StatusEntry } from "./types";

export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked";

export interface StatusLine {
  path: string;
  originalPath?: string;
  kind: ChangeKind;
}

export interface GroupedStatus {
  /** Changes recorded in the index — what `git commit` would include right now. */
  staged: StatusLine[];
  /** Changes in the working tree that are not staged. */
  unstaged: StatusLine[];
  /** Files git is not tracking at all. */
  untracked: StatusLine[];
}

/** `git status` letters, per its porcelain documentation. */
function kindFor(letter: string): ChangeKind | null {
  switch (letter) {
    case "M":
      return "modified";
    case "T": // typechange (e.g. file → symlink); "modified" is close enough for a list
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

/**
 * Splits entries into staged / unstaged / untracked.
 *
 * `??` is untracked and belongs to neither side — it has no index state to speak of. A merge
 * conflict (`U` on either side) is surfaced as unstaged, because that is where the user has to
 * act before anything can be committed.
 */
export function groupStatus(entries: StatusEntry[]): GroupedStatus {
  const grouped: GroupedStatus = { staged: [], unstaged: [], untracked: [] };

  for (const entry of entries) {
    const line: StatusLine = {
      path: entry.path,
      ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      kind: "modified",
    };

    if (entry.index === "?" || entry.worktree === "?") {
      grouped.untracked.push({ ...line, kind: "untracked" });
      continue;
    }

    // Conflicts use `U` on one or both sides and are never partially committable.
    if (entry.index === "U" || entry.worktree === "U") {
      grouped.unstaged.push({ ...line, kind: "conflicted" });
      continue;
    }

    const stagedKind = kindFor(entry.index);
    if (stagedKind) grouped.staged.push({ ...line, kind: stagedKind });

    const unstagedKind = kindFor(entry.worktree);
    if (unstagedKind) grouped.unstaged.push({ ...line, kind: unstagedKind });
  }

  return grouped;
}

export function totalChanges(grouped: GroupedStatus): number {
  return grouped.staged.length + grouped.unstaged.length + grouped.untracked.length;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  conflicted: "conflicted",
  untracked: "new",
};

export function labelFor(kind: ChangeKind): string {
  return KIND_LABEL[kind];
}
