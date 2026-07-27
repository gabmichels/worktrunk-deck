/**
 * Typed wrappers over the Tauri command surface (plan §3.4).
 *
 * Every return value is parsed with zod before it reaches a component. If worktrunk changes its
 * JSON, or the Rust side drifts from these types, we fail loudly here with a readable message
 * instead of rendering `undefined` somewhere deep in the tree (NFR-6, spec Q3).
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import type {
  CliResult,
  Commit,
  DeckConfig,
  GitWtResolution,
  PtyExitEvent,
  PtyOutputEvent,
  RootValidation,
  SessionId,
  TerminalChoice,
  WorkingTreeStatus,
} from "./types";

/* ------------------------------------------------------------------ schemas */

/**
 * What `list_worktrees` actually returns.
 *
 * The Rust side does fan-out and per-repo error isolation but deliberately does **not**
 * interpret worktrunk's rows — they arrive as raw JSON and `adapter.ts` normalizes them into
 * {@link DeckSnapshot}. That keeps the mapping a pure, fixture-tested function on this side of
 * the wire (plan §3.2, TASK-6) instead of split across two languages.
 */
const RawRepoResultSchema = z.object({
  repo: z.string(),
  repoPath: z.string(),
  load: z.enum(["ok", "unreadable"]),
  error: z.string().optional(),
  worktrees: z.array(z.unknown()),
});

const RawSnapshotSchema = z.object({
  repos: z.array(RawRepoResultSchema),
  generatedAt: z.number(),
});

export type RawRepoResult = z.infer<typeof RawRepoResultSchema>;
export type RawSnapshot = z.infer<typeof RawSnapshotSchema>;

const DevCommandSchema = z.object({
  command: z.array(z.string()),
  cwd: z.string().optional(),
});

const DeckConfigSchema = z.object({
  version: z.literal(1),
  repos: z.array(z.string()),
  scanRoot: z.string().optional(),
  gitWtPath: z.string().optional(),
  autoRefreshMs: z.number(),
  externalTerminal: z.string().optional(),
  preferExternalTerminal: z.boolean().optional(),
  confirmDestructive: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  crossRepoGrouping: z.boolean(),
  devByRepo: z.record(z.string(), DevCommandSchema).optional(),
  hiddenRepos: z.array(z.string()).optional(),
});

const CommitSchema = z.object({
  shortSha: z.string(),
  sha: z.string(),
  message: z.string(),
  author: z.string(),
  timestamp: z.number(),
});

const WorkingTreeStatusSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      originalPath: z.string().optional(),
      index: z.string(),
      worktree: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

const CliResultSchema = z.object({
  ok: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

const RootValidationSchema = z.object({
  ok: z.boolean(),
  repoCount: z.number(),
  rootIsRepo: z.boolean(),
  error: z.string().optional(),
});

const GitWtResolutionSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    version: z.string(),
    /** Present when worktrunk is older than the version this build targets (spec Q3). */
    warning: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const PtyOutputEventSchema = z.object({
  sessionId: z.string(),
  base64Bytes: z.string(),
});

const PtyExitEventSchema = z.object({
  sessionId: z.string(),
  code: z.number().nullable(),
});

/* ------------------------------------------------------------- parse helper */

/**
 * Thrown when the backend returns a shape we do not recognize. Carries the command name so the
 * toast can say *which* call drifted rather than just "invalid input".
 */
export class IpcShapeError extends Error {
  constructor(
    readonly command: string,
    readonly issues: string,
  ) {
    super(
      `${command}() returned an unexpected shape — this usually means a worktrunk or ` +
        `worktrunk-deck version mismatch.\n${issues}`,
    );
    this.name = "IpcShapeError";
  }
}

function parseOrThrow<T>(command: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new IpcShapeError(command, issues);
  }
  return result.data;
}

async function call<T>(command: string, schema: z.ZodType<T>, args?: Record<string, unknown>) {
  return parseOrThrow(command, schema, await invoke(command, args));
}

/* ----------------------------------------------------------------- commands */

/**
 * Fans out `git-wt list` across every configured repo, in parallel (REQ-2).
 * Feed the result through `toDeckSnapshot()` in `adapter.ts` before rendering it.
 */
export function listWorktrees(full = false): Promise<RawSnapshot> {
  return call("list_worktrees", RawSnapshotSchema, { full });
}

/**
 * Runs `git-wt switch --create <branch>` in a **pseudo-terminal**, returning its session id
 * (REQ-5).
 *
 * Not a piped stream: worktrunk asks for interactive approval the first time a repo's project
 * hooks run, and a pipe can display that prompt but never answer it — the run then hangs with
 * no way out. Render the returned session with `TerminalTab` like any other terminal.
 */
export function createWorktreePty(repoPath: string, branch: string): Promise<SessionId> {
  return call("create_worktree_pty", z.string(), { repoPath, branch });
}

/** `git-wt merge` in a PTY, for the same reason as {@link createWorktreePty} (REQ-6). */
export function mergeWorktreePty(repoPath: string, branch: string): Promise<SessionId> {
  return call("merge_worktree_pty", z.string(), { repoPath, branch });
}

/** Buffered `git-wt remove` (REQ-6). `force` discards uncommitted work — confirm first. */
export function removeWorktree(
  repoPath: string,
  branch: string,
  force = false,
): Promise<CliResult> {
  return call("remove_worktree", CliResultSchema, { repoPath, branch, force });
}

/**
 * Reads a worktree's history for the expanded card (read-only `git log`).
 *
 * This is the one place the deck calls `git` rather than `git-wt` — worktrunk has no log
 * subcommand. The backend fixes every argument except the path and the two numbers, and the
 * call can only ever read (see `git.rs`).
 */
export function listCommits(
  worktreePath: string,
  skip: number,
  limit: number,
): Promise<Commit[]> {
  return call("list_commits", z.array(CommitSchema), { worktreePath, skip, limit });
}

/** The worktree's changed paths, for the status detail modal (read-only `git status`). */
export function gitStatus(worktreePath: string): Promise<WorkingTreeStatus> {
  return call("git_status", WorkingTreeStatusSchema, { worktreePath });
}

export function openInEditor(path: string): Promise<void> {
  return invoke("open_in_editor", { path });
}

/** Opens a dev-server URL in the default browser; the backend restricts it to http(s). */
export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

/** Reveals a path in Explorer / Finder / the XDG file manager. */
export function openInFileManager(path: string): Promise<void> {
  return invoke("open_in_file_manager", { path });
}

/**
 * Opens the OS terminal at a worktree instead of the integrated one (REQ-8).
 *
 * `devCommand` is what separates "Open terminal" from "Run dev": omit it for a plain shell,
 * pass one to start the dev server. The backend does not look it up — see `run_external`.
 */
export function runExternal(
  repoPath: string,
  worktreePath: string,
  devCommand?: string[],
): Promise<void> {
  return invoke("run_external", { repoPath, worktreePath, devCommand });
}

const TerminalChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  path: z.string().nullable(),
  takesCommand: z.boolean(),
});

/**
 * The terminals this build knows about, each flagged with whether it is installed.
 *
 * Only the backend can answer this — detection is a filesystem probe of `PATH`,
 * `/Applications` and `%ProgramFiles%`, none of which the webview can see.
 */
export function listTerminals(): Promise<TerminalChoice[]> {
  return call("list_terminals", z.array(TerminalChoiceSchema), {});
}

/* --------------------------------------------------------------------- PTY */

/** Opens an interactive PTY rooted in `cwd`; omit `cmd` for the user's default shell (REQ-7). */
export function ptyOpen(cwd: string, cmd?: string[]): Promise<SessionId> {
  return call("pty_open", z.string(), { cwd, cmd: cmd ?? null });
}

export function ptyWrite(sessionId: SessionId, data: string): Promise<void> {
  return invoke("pty_write", { sessionId, data });
}

export function ptyResize(sessionId: SessionId, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { sessionId, cols, rows });
}

export function ptyKill(sessionId: SessionId): Promise<void> {
  return invoke("pty_kill", { sessionId });
}

/* ------------------------------------------------------------------ config */

export function getConfig(): Promise<DeckConfig> {
  return call("get_config", DeckConfigSchema);
}

export function setConfig(config: DeckConfig): Promise<void> {
  return invoke("set_config", { config });
}

/** Powers the settings panel's live "Workspace OK — N repos found" (REQ-13). */
export function validateRoot(path: string): Promise<RootValidation> {
  return call("validate_root", RootValidationSchema, { path });
}

/** Locates the `git-wt` binary and reports its version, or why it could not be found. */
export function resolveGitWt(): Promise<GitWtResolution> {
  return call("resolve_gitwt", GitWtResolutionSchema);
}

/** The deck's own version, from the built app rather than a duplicated constant. */
export function appVersion(): Promise<string> {
  return getVersion();
}

/** `"windows" | "macos" | "linux" | …` — drives the setup screen's install instructions. */
export function hostPlatform(): Promise<string> {
  return call("host_platform", z.string());
}

/* ------------------------------------------------------------------ events */

function subscribe<T>(
  event: string,
  schema: z.ZodType<T>,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen(event, (e) => handler(parseOrThrow(event, schema, e.payload)));
}

export const onPtyOutput = (h: (e: PtyOutputEvent) => void) =>
  subscribe("pty-output", PtyOutputEventSchema, h);

export const onPtyExit = (h: (e: PtyExitEvent) => void) =>
  subscribe("pty-exit", PtyExitEventSchema, h);
