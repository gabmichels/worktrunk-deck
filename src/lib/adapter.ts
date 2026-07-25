/**
 * Raw worktrunk JSON → the normalized types the UI renders (plan §3.1 → §3.2).
 *
 * This is the single place that understands `git-wt`'s wire format (NFR-6). It is a pure
 * function with no imports from Tauri, so it is tested directly against recorded fixtures in
 * `test/fixtures/` (TASK-3).
 *
 * **It must never throw.** worktrunk is a separate program on its own release cadence; a field
 * we did not expect must degrade one card, not blank the dashboard (REQ-11, REQ-15, spec Q3).
 * Every read below is defensive for that reason, and `list.malformed.json` exists to prove it.
 */
import type { RawRepoResult, RawSnapshot } from "./ipc";
import type { DeckSnapshot, RepoResult, Worktree } from "./types";

/* ------------------------------------------------------- defensive readers */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerces to a finite number; anything else (null, "many", NaN) becomes `fallback`. */
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  // Note: the string "true" is *not* accepted — a type change like that is drift we would
  // rather see as a wrong-looking card than silently paper over.
  return typeof v === "boolean" ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function aheadBehind(v: unknown): { ahead: number; behind: number } {
  const o = obj(v);
  return { ahead: num(o.ahead), behind: num(o.behind) };
}

/* ------------------------------------------------------------- the mapping */

/**
 * A row is usable only if it identifies a worktree. Without a branch there is nothing to label
 * a card with or to pass to `git-wt merge`/`remove`, so such rows are dropped.
 */
function isUsableRow(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && typeof raw.branch === "string" && raw.branch.length > 0;
}

/**
 * Maps one worktrunk row onto {@link Worktree}.
 *
 * Field notes from real output (see `test/fixtures/README.md`):
 * - `main` is **absent on the main worktree** — there is nothing to compare against, so 0/0.
 * - `remote` is absent when the branch has no upstream; that is `null`, not 0/0, because
 *   "no upstream" and "in sync with upstream" must render differently (REQ-2).
 * - `url` may be missing; only a string is a URL.
 */
export function toWorktree(
  raw: Record<string, unknown>,
  repo: string,
  repoPath: string,
): Worktree {
  const workingTree = obj(raw.working_tree);
  const commit = obj(raw.commit);
  const diff = obj(workingTree.diff);

  return {
    repo,
    repoPath,
    branch: str(raw.branch),
    path: str(raw.path),
    isMain: bool(raw.is_main),
    git: isDirty(workingTree) ? "dirty" : "clean",
    diff: { added: num(diff.added), deleted: num(diff.deleted) },
    main: aheadBehind(raw.main),
    remote: isRecord(raw.remote) ? aheadBehind(raw.remote) : null,
    head: {
      shortSha: str(commit.short_sha),
      message: str(commit.message),
      timestamp: num(commit.timestamp),
    },
    url: typeof raw.url === "string" && raw.url.length > 0 ? raw.url : null,
    urlActive: bool(raw.url_active),
  };
}

/**
 * Dirty means *any* pending change. worktrunk reports the five states separately; the deck
 * collapses them to one dot and leaves the detail to the diff counts (REQ-2).
 */
function isDirty(workingTree: Record<string, unknown>): boolean {
  return (
    bool(workingTree.staged) ||
    bool(workingTree.modified) ||
    bool(workingTree.untracked) ||
    bool(workingTree.renamed) ||
    bool(workingTree.deleted)
  );
}

/**
 * Maps one repo's raw result. An `unreadable` repo keeps its error for the inline error row
 * (REQ-15); an `ok` repo yields its usable worktrees, skipping rows we cannot render.
 *
 * The display name prefers worktrunk's own `repo.name` over the directory name, so a repo
 * checked out under a different folder name still reads correctly.
 */
export function toRepoResult(rawRepo: RawRepoResult): RepoResult {
  const rows = Array.isArray(rawRepo.worktrees) ? rawRepo.worktrees : [];
  const repoName = repoDisplayName(rows) ?? rawRepo.repo;

  if (rawRepo.load === "unreadable") {
    return {
      repo: repoName,
      repoPath: rawRepo.repoPath,
      load: "unreadable",
      error: rawRepo.error ?? "worktrunk could not read this repository.",
      worktrees: [],
    };
  }

  return {
    repo: repoName,
    repoPath: rawRepo.repoPath,
    load: "ok",
    worktrees: rows
      .filter(isUsableRow)
      .map((row) => toWorktree(row, repoName, rawRepo.repoPath)),
  };
}

function repoDisplayName(rows: unknown[]): string | undefined {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = obj(row.repo).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
}

/** Normalizes a whole poll cycle and derives the header's running count (REQ-2, TASK-18). */
export function toDeckSnapshot(raw: RawSnapshot): DeckSnapshot {
  const repos = raw.repos.map(toRepoResult);
  return {
    repos,
    generatedAt: raw.generatedAt,
    runningCount: repos.reduce(
      (n, r) => n + r.worktrees.filter((w) => w.urlActive).length,
      0,
    ),
  };
}

/** Flattens a snapshot to a single worktree list — what the aggregated view renders (REQ-3). */
export function allWorktrees(snapshot: DeckSnapshot): Worktree[] {
  return snapshot.repos.flatMap((r) => r.worktrees);
}
