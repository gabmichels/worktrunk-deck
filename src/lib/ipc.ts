/**
 * Typed wrappers over the Tauri command surface (plan §3.4).
 *
 * Every return value is parsed with zod before it reaches a component. If worktrunk changes its
 * JSON, or the Rust side drifts from these types, we fail loudly here with a readable message
 * instead of rendering `undefined` somewhere deep in the tree (NFR-6, spec Q3).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import type {
  CliLogEndEvent,
  CliLogEvent,
  CliResult,
  DeckConfig,
  GitWtResolution,
  PtyExitEvent,
  PtyOutputEvent,
  RootValidation,
  SessionId,
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

const DeckConfigSchema = z.object({
  version: z.literal(1),
  repos: z.array(z.string()),
  scanRoot: z.string().optional(),
  gitWtPath: z.string().optional(),
  autoRefreshMs: z.number(),
  externalTerminal: z.string().optional(),
  confirmDestructive: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  crossRepoGrouping: z.boolean(),
  devCommandByRepo: z.record(z.string(), z.array(z.string())).optional(),
});

const CliResultSchema = z.object({
  ok: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

const RootValidationSchema = z.object({
  ok: z.boolean(),
  repoCount: z.number(),
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

const CliLogEventSchema = z.object({
  runId: z.string(),
  line: z.string(),
  stream: z.enum(["stdout", "stderr"]),
});

const CliLogEndEventSchema = z.object({
  runId: z.string(),
  code: z.number().nullable(),
});

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
 * Starts `git-wt switch --create <branch>` (REQ-5). Resolves with a `runId` as soon as the
 * child is spawned; progress arrives as `cli-log` events — subscribe with {@link onCliLog}
 * *before* awaiting if you need the first lines.
 */
export function createWorktree(repoPath: string, branch: string): Promise<string> {
  return call("create_worktree", z.string(), { repoPath, branch });
}

/** Starts `git-wt merge` for a branch (REQ-6). Streams like {@link createWorktree}. */
export function mergeWorktree(repoPath: string, branch: string): Promise<string> {
  return call("merge_worktree", z.string(), { repoPath, branch });
}

/** Buffered `git-wt remove` (REQ-6). `force` discards uncommitted work — confirm first. */
export function removeWorktree(
  repoPath: string,
  branch: string,
  force = false,
): Promise<CliResult> {
  return call("remove_worktree", CliResultSchema, { repoPath, branch, force });
}

export function openInEditor(path: string): Promise<void> {
  return invoke("open_in_editor", { path });
}

/** Opens a dev-server URL in the default browser; the backend restricts it to http(s). */
export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

/** Launches the repo's dev command in the OS terminal instead of the integrated one (REQ-8). */
export function runExternal(repoPath: string, worktreePath: string): Promise<void> {
  return invoke("run_external", { repoPath, worktreePath });
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

/* ------------------------------------------------------------------ events */

function subscribe<T>(
  event: string,
  schema: z.ZodType<T>,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen(event, (e) => handler(parseOrThrow(event, schema, e.payload)));
}

export const onCliLog = (h: (e: CliLogEvent) => void) => subscribe("cli-log", CliLogEventSchema, h);

export const onCliLogEnd = (h: (e: CliLogEndEvent) => void) =>
  subscribe("cli-log-end", CliLogEndEventSchema, h);

export const onPtyOutput = (h: (e: PtyOutputEvent) => void) =>
  subscribe("pty-output", PtyOutputEventSchema, h);

export const onPtyExit = (h: (e: PtyExitEvent) => void) =>
  subscribe("pty-exit", PtyExitEventSchema, h);
