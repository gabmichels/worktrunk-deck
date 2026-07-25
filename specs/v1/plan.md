# worktrunk-deck — Implementation Plan

**Status:** draft · **Implements:** [`spec.md`](./spec.md) · **Last updated:** 2026-07-25

> **HOW.** Every decision traces to a requirement in `spec.md`. The ordered build steps are in
> [`tasks.md`](./tasks.md).

## 1. Architecture overview

A Tauri v2 desktop app. The frontend is a React SPA; the Rust backend is a thin broker that
(a) invokes the `git-wt` CLI, (b) manages interactive PTY sessions, and (c) persists config.

```
┌─────────────────────────── Tauri window ───────────────────────────┐
│  React + Vite frontend                                              │
│   Header · FilterBar · WorktreeCards/FeatureGroups · TerminalSidebar│
│        │  invoke(...)            ▲ events (pty-output, cli-log)      │
│        ▼                          │                                 │
│  Rust backend (broker — NO worktree/port logic)                    │
│   gitwt.rs ─► spawn `git-wt -C <repo> <allowlisted subcmd>`         │
│   pty.rs   ─► portable-pty session ⇄ worktree shell/dev command     │
│   config.rs─► load/save deck config                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
                     git-wt (worktrunk)  ──►  git / dev servers
```

**Load-bearing decisions:**

1. **The backend has no business logic.** Worktree state comes verbatim from
   `git-wt list --format json`; actions are `git-wt` subcommands. This is what keeps the app a
   thin, correct view (NFR-6, Non-goals).
2. **worktrunk is invoked per-repo, in parallel.** `git-wt` operates on one repo (`-C <path>`);
   the deck holds the repo list and fans out concurrently, aggregating results (NFR-4/5).
3. **The integrated terminal is a real PTY, not a log tee.** `portable-pty` gives a
   cross-platform pseudo-terminal (ConPTY on Windows) so the user gets an interactive shell,
   not just streamed stdout (REQ-7).

## 2. Tech stack & rationale

| Area | Choice | Why (→ REQ/NFR) |
|---|---|---|
| Desktop shell | **Tauri v2** | One codebase → Windows/macOS/Linux; small binaries; Rust backend for PTY/process control (NFR-1) |
| Frontend | **React 19 + Vite + TypeScript** | Fast, familiar, strong ecosystem; matches team skills |
| Styling | **Tailwind v4 + shadcn/ui** | Consistent, themeable, light/dark out of the box (NFR-7) |
| Terminal UI | **xterm.js** (+ fit/websocket-free addon) | De-facto web terminal emulator for REQ-7 |
| PTY backend | **`portable-pty`** (wezterm crate) | Cross-platform PTY incl. Windows ConPTY (REQ-7, NFR-1) |
| Process/plugins | `tauri-plugin-shell`, `-dialog`, `-opener` | Allowlisted spawn, file pickers, safe URL/editor open (NFR-3) |
| IPC validation | **zod** at the frontend boundary | Fail loud on `git-wt`/schema drift (NFR-6, Q3) |
| Icons/toasts | `lucide-react`, `sonner` | Lightweight, OSS |
| Package mgr | **pnpm**, Node ≥ 22 | Consistent with team tooling |

Note: unlike the source guide, **there is no compiled CLI sidecar** — `git-wt` is a
user-installed binary we locate on PATH (with a config override), so we drop bundling entirely.

## 3. Data & contract models

### 3.1 The `git-wt list --format json` contract (input)

Run `git-wt -C <repoPath> list --format json` (add `--full` for CI/diff/summary columns —
slower, opt-in). It returns a **JSON array**, one object per worktree. The fields the deck
consumes (captured from worktrunk on a real repo; treat unknown fields as ignorable):

```jsonc
{
  "branch": "fix/coach-memory-write-loss",
  "path": "C:/Workspace/dryll.fix-coach-memory-write-loss",
  "kind": "worktree",
  "commit": { "sha": "…", "short_sha": "5a120fd", "message": "…", "timestamp": 1782553568 },
  "working_tree": {
    "staged": false, "modified": true, "untracked": true, "renamed": false, "deleted": false,
    "diff": { "added": 368, "deleted": 1 }
  },
  "main_state": "same_commit | is_main | ahead | behind | diverged",
  "main":   { "ahead": 0, "behind": 0, "diff": { "added": 0, "deleted": 0 } },
  "remote": { "name": "origin", "branch": "main", "ahead": 0, "behind": 0 },
  "worktree": { "detached": false },
  "is_main": false, "is_current": false, "is_previous": false,
  "repo": { "url": "…", "provider": "github", "host": "github.com", "owner": "…", "name": "dryll", "remote": "origin" },
  "url": "http://localhost:12107",   // dev-server URL worktrunk assigns
  "url_active": false,               // whether that URL is currently listening
  "statusline": "…(ANSI)…", "symbols": "!?^|"
}
```

> A full sample must be captured as a test fixture — see TASK-3. worktrunk assigns ports by
> branch hash (10000–19999); the deck only **displays** `url`/`url_active` and never computes
> ports itself.

### 3.2 Normalized frontend types (what components render)

The adapter (TASK-6) maps raw `git-wt` JSON → these; components never see raw JSON.

```ts
export type GitState = "clean" | "dirty";
export type RepoLoad = "ok" | "unreadable";      // per-repo error isolation (REQ-15)

export interface Worktree {
  repo: string;            // repo display name (from config or repo.name)
  repoPath: string;        // absolute repo root
  branch: string;
  path: string;            // worktree dir
  isMain: boolean;
  git: GitState;
  diff: { added: number; deleted: number };
  main: { ahead: number; behind: number };
  remote: { ahead: number; behind: number } | null;
  head: { shortSha: string; message: string; timestamp: number };
  url: string | null;
  urlActive: boolean;
}

export interface RepoResult {
  repo: string;
  repoPath: string;
  load: RepoLoad;
  error?: string;          // populated when load === "unreadable"
  worktrees: Worktree[];
}

export interface DeckSnapshot {           // one poll cycle, all repos
  repos: RepoResult[];
  generatedAt: number;
  runningCount: number;                   // worktrees with urlActive === true
}
```

### 3.3 Deck config (persisted locally)

Stored via Tauri's app-config dir (`$APPCONFIG/worktrunk-deck/config.json`), cross-platform.

```ts
export interface DeckConfig {
  version: 1;
  repos: string[];               // explicit repo root paths
  scanRoot?: string;             // optional dir to auto-discover git repos under
  gitWtPath?: string;            // override if `git-wt` not on PATH
  autoRefreshMs: number;         // 0 = off (still refresh on focus/manual)
  externalTerminal?: string;     // OS-specific choice; see §5
  confirmDestructive: boolean;   // default true
  theme: "system" | "light" | "dark";
  crossRepoGrouping: boolean;    // default false (REQ-4)
  devCommandByRepo?: Record<string, string[]>; // optional per-repo dev command for terminal "Run"
}
```

### 3.4 Tauri command surface (frontend ⇆ Rust)

```
list_worktrees(full: bool) -> DeckSnapshot            // fans out git-wt per repo, parallel
create_worktree(repoPath, branch) -> stream(cli-log)  // git-wt switch --create
merge_worktree(repoPath, branch) -> stream(cli-log)   // git-wt merge
remove_worktree(repoPath, branch, force) -> CliResult // git-wt remove
open_in_editor(path) -> ()                             // opener/editor
open_url(url) -> ()                                    // opener, restricted to localhost/http(s)
run_external(repoPath, worktreePath) -> ()             // launch dev cmd in OS terminal

// PTY (REQ-7)
pty_open(cwd, cmd?: string[]) -> sessionId
pty_write(sessionId, data)
pty_resize(sessionId, cols, rows)
pty_kill(sessionId)
// events: "pty-output" { sessionId, base64Bytes }, "pty-exit" { sessionId, code }

// config
get_config() -> DeckConfig
set_config(DeckConfig) -> ()
validate_root(path) -> { ok: bool, repoCount: number }  // powers "Workspace OK (N repos)"
resolve_gitwt() -> { path: string, version: string } | { error }
```

### 3.5 `git-wt` allowlist (enforced in Rust — NFR-3)

Only these subcommands may be spawned: `list`, `switch`, `merge`, `remove`. Everything else is
rejected before spawn. Invocations always pass explicit `-C <repoPath>`; the deck never relies
on process cwd. The integrated terminal (PTY) is separate and user-driven, rooted in a
worktree dir.

## 4. Module / file layout

```
worktrunk-deck/
├── src/                              # frontend
│   ├── lib/
│   │   ├── types.ts                  # §3.2 types
│   │   ├── ipc.ts                    # typed invoke() wrappers + zod schemas
│   │   ├── adapter.ts                # raw git-wt JSON -> Worktree (pure, unit-tested)
│   │   └── config.ts                 # config get/set helpers
│   ├── hooks/
│   │   ├── useWorktrees.ts           # poll list_worktrees; stale-while-error (REQ-11)
│   │   └── usePty.ts                 # open/write/resize/kill; bind to xterm
│   ├── components/
│   │   ├── Header.tsx  FilterBar.tsx
│   │   ├── WorktreeCard.tsx  FeatureGroup.tsx  IsolatedWorktrees.tsx
│   │   ├── TerminalSidebar.tsx  TerminalTab.tsx
│   │   ├── SettingsModal.tsx  HelpModal.tsx  NewWorktreeModal.tsx  FirstRunGate.tsx
│   │   └── ui/                       # shadcn primitives
│   └── App.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs  lib.rs
│   │   ├── gitwt.rs                  # allowlist + spawn (buffered + streaming)
│   │   ├── pty.rs                    # portable-pty session registry
│   │   ├── config.rs                 # load/save/validate DeckConfig
│   │   ├── commands.rs               # #[tauri::command] surface (§3.4)
│   │   └── error.rs
│   ├── capabilities/default.json     # restrict shell/opener (NFR-3)
│   ├── Cargo.toml  tauri.conf.json
├── specs/v1/{spec,plan,tasks}.md
├── .github/workflows/ci.yml          # build matrix win/mac/linux
├── LICENSE  README.md
```

## 5. External dependencies & integrations

- **`git-wt` (worktrunk)** — required, user-installed. Resolve via PATH; allow `gitWtPath`
  override (GUI launches have a minimal PATH — mitigate with override + a login-shell/registry
  probe). Missing binary → clear first-run/error state, not a crash (REQ-15).
- **Editors:** try `cursor`, then `code`, then OS-open the folder.
- **External terminals:** Windows → Windows Terminal (`wt`) / PowerShell; macOS → Terminal /
  iTerm2 / Warp; Linux → `$TERMINAL` / common emulators. Best-effort with a safe default.
- **`git`** — present transitively (worktrunk needs it); deck does not call it directly.

## 6. Phases / milestones

Each milestone is independently runnable and testable.

- **M1 — Read-only dashboard.** Config + repo discovery, `list_worktrees` fan-out, adapter,
  `useWorktrees` polling, WorktreeCard rendering (branch/status/ahead-behind/url dot). *Verify:*
  point at a folder of repos, see live worktrees; dot flips when a server starts.
- **M2 — Lifecycle actions.** New worktree, merge, remove — via `git-wt`, with streamed output
  and destructive-confirm. *Verify:* create→appears, remove→disappears, both prompt.
- **M3 — Integrated terminal (core).** `pty.rs` + `usePty` + TerminalSidebar with tabs; open a
  shell in a worktree, run the dev command, interact; "Run externally" too. *Verify:* type in
  the terminal; dev server logs stream; sessions die on quit.
- **M4 — Full UI.** Header/running pill, FilterBar, IsolatedWorktrees, SettingsModal (with
  live `validate_root`), HelpModal legend, FirstRunGate, optional cross-repo grouping,
  stale-while-error polish. *Verify:* against the reference screenshots' feature set.
- **M5 — OSS hardening.** LICENSE, README (build/run/contribute), CI build matrix for three
  OSes, release bundling, unsigned-launch notes. *Verify:* green CI on all three; a stranger
  can build from the README.

## 7. Risks & mitigations

| Risk | L/I | Mitigation |
|---|---|---|
| `git-wt` not on PATH when launched from GUI | High/High | `gitWtPath` override + PATH/login-shell probe; `resolve_gitwt()` surfaces a clear setup error |
| PTY cross-platform quirks (Windows ConPTY) | Med/High | `portable-pty` abstracts it; test terminal on all three OSes in M3 |
| worktrunk JSON schema drift across versions | Med/Med | zod-validate at boundary; tolerate unknown fields; pin min version; friendly mismatch message (Q3) |
| `--full` slowness (network/LLM summaries) | Med/Low | `--full` opt-in per refresh, run in background, never block base list (NFR-4) |
| Running a dev server from the *primary* checkout watching into nested `.claude/worktrees` | Low/Med | Deck runs servers **in worktrees**, not the primary; document the nested-layout watcher caveat |
| Bundling/signing friction on macOS/Windows | Med/Low | v1 ships unsigned with documented de-quarantine steps; signing is post-v1 |

## 8. Testing strategy

- **Unit (pure, fast):** `adapter.ts` against the captured JSON fixture (TASK-3), including the
  unreadable-repo and malformed-row cases; config validation; the Rust allowlist (rejects
  non-listed subcommands).
- **Integration:** spawn `git-wt` against a throwaway temp repo (create worktree, list, remove)
  behind a feature-gated test so CI can skip if `git-wt` is absent.
- **Manual matrix:** the acceptance checklist in `spec.md` §7, run on Windows, macOS, Linux —
  with special attention to the integrated terminal (M3) per OS.
- **CI:** typecheck + unit tests + `tauri build` on a three-OS matrix (NFR-1).
