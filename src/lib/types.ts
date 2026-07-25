/**
 * Normalized types the UI renders (plan §3.2 / §3.3).
 *
 * Components never see raw `git-wt` JSON — `adapter.ts` maps it into these first. That keeps
 * worktrunk's wire format in exactly two places (the Rust adapter boundary and `adapter.ts`)
 * so a schema change has one home (NFR-6).
 */

export type GitState = "clean" | "dirty";

/** Per-repo error isolation: one bad repo must not break the view (REQ-15). */
export type RepoLoad = "ok" | "unreadable";

export interface Worktree {
  /** Repo display name (config label, else `repo.name` from worktrunk). */
  repo: string;
  /** Absolute repo root — the `-C` target for any action on this worktree. */
  repoPath: string;
  branch: string;
  /** The worktree directory itself (differs from `repoPath` for non-main worktrees). */
  path: string;
  isMain: boolean;
  git: GitState;
  diff: { added: number; deleted: number };
  /** Ahead/behind the repo's default branch. */
  main: { ahead: number; behind: number };
  /** Ahead/behind the tracking branch; null when the branch has no upstream. */
  remote: { ahead: number; behind: number } | null;
  head: { shortSha: string; message: string; timestamp: number };
  /** Dev-server URL worktrunk assigned to this branch. Display only — never computed here. */
  url: string | null;
  /** Whether that URL is currently listening, per worktrunk. */
  urlActive: boolean;
}

export interface RepoResult {
  repo: string;
  repoPath: string;
  load: RepoLoad;
  /** Populated when `load === "unreadable"` — worktrunk's stderr, shown inline. */
  error?: string;
  worktrees: Worktree[];
}

/** One poll cycle across all configured repos. */
export interface DeckSnapshot {
  repos: RepoResult[];
  generatedAt: number;
  /** Worktrees with `urlActive === true`, across all repos. */
  runningCount: number;
}

export type Theme = "system" | "light" | "dark";

export interface DeckConfig {
  version: 1;
  /** Explicit repo root paths. */
  repos: string[];
  /** Optional directory to auto-discover git repos under. */
  scanRoot?: string;
  /** Override when `git-wt` is not on PATH (common for GUI launches). */
  gitWtPath?: string;
  /** 0 = off; the deck still refreshes on focus and on demand (REQ-11). */
  autoRefreshMs: number;
  /** OS-specific terminal choice for "Run externally" (REQ-8). */
  externalTerminal?: string;
  confirmDestructive: boolean;
  theme: Theme;
  /** Display-only cross-repo grouping (REQ-4); off by default. */
  crossRepoGrouping: boolean;
  /**
   * Per-repo dev command for the terminal's "Run dev" action, keyed by repo path.
   *
   * `cwd` is relative to the **worktree** root, not the repo root — monorepos commonly keep
   * the dev server in `apps/web` or similar, and each worktree has its own copy of that tree.
   */
  devByRepo?: Record<string, DevCommand>;
  /**
   * Repos the user has explicitly hidden from the dashboard, by repo path. Kept separate from
   * the repo list so hiding is reversible without losing configuration.
   */
  hiddenRepos?: string[];
}

export interface DevCommand {
  command: string[];
  /** Relative to the worktree root. Empty or absent means the worktree root itself. */
  cwd?: string;
}

export const DEFAULT_CONFIG: DeckConfig = {
  version: 1,
  repos: [],
  autoRefreshMs: 5000,
  confirmDestructive: true,
  theme: "system",
  crossRepoGrouping: false,
};

/** One entry of a worktree's history, for the expanded card view. */
export interface Commit {
  shortSha: string;
  sha: string;
  message: string;
  author: string;
  /** Unix seconds, as git reports it. */
  timestamp: number;
}

/** Result of a buffered `git-wt` action (merge/remove). */
export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RootValidation {
  ok: boolean;
  repoCount: number;
  /** Populated when `ok` is false — why the path is unusable. */
  error?: string;
}

export type GitWtResolution =
  /** `warning` is set when worktrunk is older than the version this build targets (spec Q3). */
  | { ok: true; path: string; version: string; warning?: string }
  | { ok: false; error: string };

/** A live PTY session (REQ-7). */
export type SessionId = string;

/** Streamed output from a long-running `git-wt` action (TASK-9). */
export interface CliLogEvent {
  runId: string;
  line: string;
  stream: "stdout" | "stderr";
}

export interface CliLogEndEvent {
  runId: string;
  code: number | null;
}

export interface PtyOutputEvent {
  sessionId: SessionId;
  /** Base64 — PTY output is bytes, not necessarily valid UTF-8 mid-chunk. */
  base64Bytes: string;
}

export interface PtyExitEvent {
  sessionId: SessionId;
  code: number | null;
}
