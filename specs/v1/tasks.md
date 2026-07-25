# worktrunk-deck — Tasks

**Status:** ready · **Implements:** [`spec.md`](./spec.md) + [`plan.md`](./plan.md) · **Last updated:** 2026-07-25

> Execution layer. Each task is atomic and carries a **context brief** so it can be done with
> no memory of the design conversation — the repo + these three docs are enough. Ordered by
> milestone; the **Depends on / Unblocks** lines are the real graph (anything with no unmet
> dependency can run in parallel). Requires `git-wt` (worktrunk) installed and Node ≥ 22 + pnpm.

### Dependency graph

```
M0  TASK-1 ─┬─ TASK-2 ───────────────┐
            ├─ TASK-3 ──────┐        │
            └─ TASK-4 ─ TASK-5 ─ TASK-6 ─ TASK-7 ─ TASK-8  ← M1 done (read-only dashboard)
M2  TASK-8 ─ TASK-9 ─┬─ TASK-11 ─ TASK-12
                     └─ TASK-10 ─ TASK-11
M3  TASK-8 ─ TASK-13 ─ TASK-14 ─ TASK-15 ─ TASK-17     (TASK-16 parallel)
M4  TASK-8 ─ TASK-18 ─ TASK-20 ;  TASK-4 ─ TASK-19 ;  TASK-8 ─ TASK-21
M5  (everything) ─ TASK-22, TASK-23
```

---

## M0 — Scaffold

### TASK-1 — Scaffold the Tauri v2 + React/Vite/TS app · plan §2, §4
**Depends on:** none · **Unblocks:** TASK-2, TASK-3, TASK-4

**Context brief.** Empty starting point. Create the project skeleton exactly as `plan.md` §4
lays out, with the §2 stack: Tauri v2 shell, React 19 + Vite + TS frontend, Tailwind v4 +
shadcn/ui, pnpm. No app logic yet — just a window that opens and hot-reloads.

**Steps.** 1) `pnpm create tauri-app` (React + TS + Vite). 2) Add Tailwind v4 (`@tailwindcss/vite`)
+ shadcn init. 3) Add plugins `tauri-plugin-shell/-dialog/-opener`. 4) Create the empty dir
structure from §4.

**Done when.** `pnpm tauri dev` opens a window on the current OS with a themed placeholder;
`pnpm build` and `cargo build` both succeed.

### TASK-2 — Frontend types, zod schemas, typed IPC wrappers · plan §3.2, §3.4
**Depends on:** TASK-1 · **Unblocks:** TASK-6, TASK-7, and all UI tasks

**Context brief.** Everything downstream renders the normalized types, never raw `git-wt`
JSON. Define `Worktree`, `RepoResult`, `DeckSnapshot`, `DeckConfig` (plan §3.2/§3.3) in
`src/lib/types.ts`. In `src/lib/ipc.ts`, wrap each Tauri command from §3.4 in a typed
`invoke()` and validate the return with a **zod** schema that throws loudly on shape mismatch
(guards against worktrunk schema drift — NFR-6/Q3). Backends can be stubs for now.

**Steps.** 1) Port §3.2/§3.3 types verbatim. 2) zod schema per command return. 3) `invoke`
wrappers that parse-or-throw.

**Done when.** `pnpm typecheck` passes; importing `ipc.ts` and calling a stubbed command
returns a validated (or clearly-thrown) result.

### TASK-3 — Capture a real `git-wt list --format json` fixture · plan §3.1, §8
**Depends on:** TASK-1 · **Unblocks:** TASK-6

**Context brief.** The adapter and its tests need real data. Run
`git-wt -C <any real repo> list --format json` (and once with `--full`) and save the output
as fixtures. Include a repo with ≥2 worktrees, a dirty one, and a listening dev server so
`url_active:true` appears at least once. Also hand-craft an "unreadable repo" error sample and
a malformed row for negative tests.

**Steps.** 1) Save `test/fixtures/list.basic.json`, `list.full.json`. 2) Add
`list.unreadable.json`, `list.malformed.json`. 3) Note the capture command in a fixtures README.

**Done when.** Fixtures exist and match the §3.1 shape; the fixtures README documents how they
were produced.

---

## M1 — Read-only dashboard

### TASK-4 — `config.rs`: load/save/validate config + resolve `git-wt` · plan §3.3, §5, §7(risk)
**Depends on:** TASK-1 · **Unblocks:** TASK-5, TASK-19

**Context brief.** The app must know which repos to scan and where `git-wt` is. Implement
`DeckConfig` persistence in Tauri's app-config dir (`$APPCONFIG/worktrunk-deck/config.json`),
plus `validate_root(path)` (count git repos under it — powers "Workspace OK (N repos)") and
`resolve_gitwt()` (find `git-wt` on PATH; honor `gitWtPath` override; return version or a clear
error). GUI launches have a minimal PATH — probe a login shell / common install dirs as
fallback.

**Steps.** 1) Serde `DeckConfig` load/save with defaults. 2) `validate_root`. 3) `resolve_gitwt`
with override + PATH probe + `git-wt --version`.

**Done when.** Config round-trips to disk; `validate_root` returns a correct repo count for a
test dir; `resolve_gitwt` finds the binary or returns a descriptive error.

### TASK-5 — `gitwt.rs` + `list_worktrees`: parallel per-repo fan-out · plan §3.1, §3.4, §3.5, NFR-4/5/15
**Depends on:** TASK-4 · **Unblocks:** TASK-6

**Context brief.** Core read path. Implement an allowlisted buffered spawn of `git-wt` (only
`list|switch|merge|remove` — reject others, NFR-3), always with explicit `-C <repoPath>`. The
`list_worktrees(full)` command reads the config's repos, invokes
`git-wt -C <repo> list --format json [--full]` for each **in parallel**, and returns a
`DeckSnapshot` where each repo is a `RepoResult` — a failed/unreadable repo becomes
`load:"unreadable"` with its stderr, never aborting the others (REQ-15).

**Steps.** 1) Allowlisted `run_gitwt(repo, args) -> Result<String>`. 2) Parallel map over repos
(tokio). 3) Assemble `DeckSnapshot`; count `url_active` for `runningCount`.

**Done when.** With two configured repos (one deliberately broken path), `list_worktrees`
returns both — good data for one, an `unreadable` error for the other — within ~1s.

### TASK-6 — `adapter.ts`: raw JSON → `Worktree[]` (+ unit tests) · plan §3.1→§3.2
**Depends on:** TASK-2, TASK-3, TASK-5 · **Unblocks:** TASK-7

**Context brief.** Pure transform, the most-tested unit in the app. Map each raw `git-wt`
worktree object (§3.1) to the normalized `Worktree` (§3.2): `working_tree.modified||staged||…`
→ `git:"dirty"`, pass through `url`/`url_active`, `main`/`remote` ahead-behind, `commit` →
`head`. Unreadable repos surface as a `RepoResult` with `load:"unreadable"`; a malformed row
must yield a safe skip/`unreadable`, never throw. Test against all four fixtures from TASK-3.

**Steps.** 1) `toWorktree(raw)`. 2) `toRepoResult(rawArrayOrError)`. 3) Vitest cases per fixture
incl. malformed + unreadable.

**Done when.** `pnpm test src/lib/adapter.test.ts` is green, including the malformed-row test
asserting no throw.

### TASK-7 — `useWorktrees.ts`: polling with stale-while-error · plan §3.4, REQ-11
**Depends on:** TASK-6 · **Unblocks:** TASK-8

**Context brief.** The live-data hook. Poll `list_worktrees` every `autoRefreshMs` (0 = off),
refetch on window focus, expose a manual `refresh()`. Critically: a failed poll **keeps the
last good `DeckSnapshot`** and sets `isStale` — never blank the UI (REQ-11). Pause polling when
the window is hidden a while; refetch on focus.

**Steps.** 1) Interval + focus listeners. 2) Keep-last-good on error, set `isStale`. 3) Expose
`{ snapshot, isStale, isLoading, refresh }`.

**Done when.** Simulating a failing poll (temporarily break `git-wt` path) keeps the previous
cards visible with a staleness flag; restoring it clears the flag on the next tick.

### TASK-8 — `WorktreeCard` + base layout: the read-only view (M1 complete) · plan §1, REQ-2/3
**Depends on:** TASK-7 · **Unblocks:** TASK-9, TASK-13, TASK-18, TASK-21

**Context brief.** First visually useful build. Render the `DeckSnapshot` as a scrolling list
of **single-repo cards** (REQ-3): per worktree show branch, a clean/dirty dot, ahead/behind
vs main and remote, HEAD short-sha + message, and the dev-server URL with a live/not-live dot
(`urlActive`). Group cards under their repo; render a `RepoResult.load==="unreadable"` repo as
an inline error row (REQ-15). No actions yet.

**Steps.** 1) `WorktreeCard`. 2) Repo grouping + unreadable error row. 3) Wire `useWorktrees`
into `App.tsx`.

**Done when.** Pointing the config at a folder of real repos shows their worktrees; starting a
dev server flips a card's dot to live within one refresh (satisfies spec §7 bullet 2).

---

## M2 — Lifecycle actions

### TASK-9 — Streaming spawn + `create_worktree` / `merge_worktree` · plan §3.4, REQ-5/6
**Depends on:** TASK-8 · **Unblocks:** TASK-11, TASK-12

**Context brief.** Long-running writes must stream progress. Add a streaming variant to
`gitwt.rs` that forwards child stdout/stderr as `cli-log` events (`{ runId, line }`) and ends
with `cli-log-end`. Implement `create_worktree(repoPath, branch)` → `git-wt switch --create
<branch>` and `merge_worktree(repoPath, branch)` → `git-wt merge`, both streamed.

**Steps.** 1) `run_gitwt_streaming(runId, repo, args)`. 2) Two commands. 3) Emit events; refresh
list on completion.

**Done when.** Creating a worktree from a test branch streams output and the new worktree
appears in the list after `cli-log-end`.

### TASK-10 — `remove_worktree` · plan §3.4, REQ-6/12
**Depends on:** TASK-8 · **Unblocks:** TASK-11

**Context brief.** Buffered destructive action: `remove_worktree(repoPath, branch, force)` →
`git-wt remove` (force flag when the caller confirms an override). Returns a `CliResult`
(ok/stderr).

**Steps.** 1) Command with optional `--force`. 2) Surface stderr on failure.

**Done when.** Removing a merged test worktree makes it disappear from the list; removing a
dirty one without force returns worktrunk's refusal as a readable error.

### TASK-11 — `NewWorktreeModal` + card actions with destructive-confirm · REQ-5/6/12
**Depends on:** TASK-9, TASK-10 · **Unblocks:** —

**Context brief.** Wire the write commands to the UI. Add a "New worktree" modal (repo picker +
branch name → `create_worktree`) and per-card Merge/Remove actions. Guard Merge and Remove
behind a confirmation dialog controlled by `config.confirmDestructive` (REQ-12).

**Steps.** 1) `NewWorktreeModal`. 2) Card action menu. 3) Confirm dialog gated on config.

**Done when.** Full create→merge→remove lifecycle works from the UI; destructive actions prompt
unless the setting is off.

### TASK-12 — Transitory streamed-output panel · REQ-5 (pre-terminal)
**Depends on:** TASK-9 · **Unblocks:** —

**Context brief.** Before the full terminal (M3), give create/merge a place to show their
`cli-log` stream. A simple read-only panel subscribing to `cli-log`/`cli-log-end`. This is
superseded by the terminal sidebar but keeps M2 usable on its own.

**Steps.** 1) Subscribe to events. 2) Append lines. 3) Toast on completion.

**Done when.** Running create/merge shows live output in the panel and a success/failure toast.

---

## M3 — Integrated terminal (core v1)

### TASK-13 — `pty.rs`: cross-platform PTY session registry · plan §2, §3.4, REQ-7
**Depends on:** TASK-8 · **Unblocks:** TASK-14

**Context brief.** The differentiator. Using `portable-pty`, implement a session registry:
`pty_open(cwd, cmd?)` spawns a PTY (default shell, or `cmd` if given) rooted in `cwd`, returns
a `sessionId`, and streams output as `pty-output { sessionId, base64Bytes }` events;
`pty_write`, `pty_resize`, `pty_kill` control it; emit `pty-exit { sessionId, code }`. Must work
with Windows ConPTY (portable-pty handles this — verify on Windows).

**Steps.** 1) Session map (id → PtyPair + writer). 2) Reader task → base64 events. 3) write/
resize/kill; exit event.

**Done when.** `pty_open` in a worktree dir yields an interactive shell whose output arrives as
events and that accepts input via `pty_write`, verified on the dev OS (and later on all three).

### TASK-14 — `usePty` + xterm.js binding (`TerminalTab`) · plan §2, REQ-7
**Depends on:** TASK-13 · **Unblocks:** TASK-15

**Context brief.** Bridge PTY ↔ UI. `usePty(sessionId)` subscribes to `pty-output` (decode
base64 → `term.write`), sends keystrokes via `pty_write`, and calls `pty_resize` on fit. Render
an xterm.js instance in `TerminalTab` with the fit addon and theme matching the app.

**Steps.** 1) xterm + fit addon in `TerminalTab`. 2) `usePty` wiring in/out. 3) Resize on
container/window change.

**Done when.** A terminal tab shows a live shell you can type into inside a worktree; `ls`/`dir`
reflects that worktree's contents.

### TASK-15 — `TerminalSidebar` with tabs + "Run dev command" · REQ-7
**Depends on:** TASK-14 · **Unblocks:** TASK-17

**Context brief.** Compose tabs into a sidebar. A per-worktree "Open terminal" action creates a
tab; support multiple concurrent tabs; a "Run dev" action opens a tab that launches
`config.devCommandByRepo[repo]` (falling back to a prompt) in that worktree — so dev-server
logs stream in an interactive pane the user can Ctrl-C.

**Steps.** 1) Tab strip + panes. 2) Open-terminal / Run-dev actions on cards. 3) Per-repo dev
command from config.

**Done when.** Two terminals on two worktrees run side by side; "Run dev" starts the server and
its logs stream in the tab.

### TASK-16 — `run_external`: launch dev command in the OS terminal · plan §5, REQ-8
**Depends on:** TASK-8 · **Unblocks:** —  · **Parallelizable with:** TASK-13..15

**Context brief.** Some users prefer their own terminal. Implement `run_external(repoPath,
worktreePath)` that opens the OS terminal in the worktree running its dev command: Windows →
`wt`/PowerShell, macOS → Terminal/iTerm2/Warp (per `config.externalTerminal`), Linux →
`$TERMINAL`/common emulators. Best-effort with a safe default.

**Steps.** 1) Per-OS launch strategy. 2) Honor `externalTerminal` setting. 3) Fallback + toast
on failure.

**Done when.** "Run externally" opens the chosen terminal in the worktree and starts the dev
command on the current OS.

### TASK-17 — PTY lifecycle: kill all on exit + running indicator · REQ-7
**Depends on:** TASK-15 · **Unblocks:** —

**Context brief.** Sessions must not outlive the app (spec §REQ-7: "clearly killed on quit").
On window/app close, kill every PTY session; reflect active sessions in the header running
state so the user knows what's alive.

**Steps.** 1) Kill-all on Tauri exit hook. 2) Track/expose active session count.

**Done when.** Quitting the app leaves no orphaned dev-server/shell processes (verify with a
process list on each OS).

---

## M4 — Full UI

### TASK-18 — `Header` + `FilterBar` · REQ-10, reference screenshots
**Depends on:** TASK-8 · **Unblocks:** TASK-20

**Context brief.** Match the reference tool's top chrome: workspace name + version, a
running-count pill (doubles as a filter to running-only), Refresh, last-updated time, Help (?),
Settings (⚙), and a "New worktree" button. Below it a `FilterBar` that filters cards by repo /
branch / feature client-side (REQ-10).

**Done when.** Header shows an accurate running count; typing in the filter narrows the cards
live; the pill toggles running-only.

### TASK-19 — `SettingsModal` with live validation · plan §3.3, REQ-13
**Depends on:** TASK-4 · **Unblocks:** —

**Context brief.** Expose `DeckConfig` (plan §3.3): repos list / scan root (with Browse and a
live "Workspace OK (N repos)" via `validate_root`), `git-wt` path override (with
`resolve_gitwt` feedback), auto-refresh interval, external-terminal choice, confirm-destructive
toggle, theme. Persist via `set_config`.

**Done when.** Changing the scan root updates the repo count live; saving persists and the next
refresh reflects the new repo set.

### TASK-20 — `HelpModal` legend + `IsolatedWorktrees` + `FirstRunGate` · REQ-1/9/14
**Depends on:** TASK-18 · **Unblocks:** —

**Context brief.** Three UI completeness pieces: (a) `HelpModal` — a legend for every icon
(clean/dirty dot, ahead/behind, listening dot, unreadable ⚠) and an action glossary (REQ-14);
(b) `IsolatedWorktrees` — a section listing worktrees not tied to a feature, grouped by repo
(REQ-9); (c) `FirstRunGate` — block the app on a setup panel when no repos are configured or
`git-wt` is unresolved, until fixed (REQ-1).

**Done when.** Fresh config → first-run gate; after setup → dashboard with a working legend and
an isolated-worktrees section.

### TASK-21 — Optional cross-repo feature grouping · REQ-4, spec Non-goals
**Depends on:** TASK-8 · **Unblocks:** —

**Context brief.** Behind `config.crossRepoGrouping` (default off), group worktrees that share
a feature/branch identity across repos into one multi-repo `FeatureGroup` card (one row per
repo, like the reference tool). This is **display only** — do not create or coordinate
worktrees across repos (spec Non-goals). Keep the grouping heuristic isolated so it can evolve
(spec Q2).

**Done when.** Toggling the setting switches between single-repo cards and grouped feature
cards; grouping never issues cross-repo git operations.

---

## M5 — Open-source hardening

### TASK-22 — LICENSE, README, repo hygiene · NFR-2
**Depends on:** M1–M4 substantially complete · **Unblocks:** —

**Context brief.** Make it a real OSS project. Add a permissive LICENSE (MIT or Apache-2.0), a
README that lets a stranger install prerequisites (`git-wt`, Node, pnpm, Rust), build, run, and
contribute, plus a short "what is this / why" and a screenshot. Audit for any personal data or
hardcoded paths (there must be none — NFR-2).

**Done when.** A person who has never seen the project can go from clone to running app using
only the README; no personal paths/data anywhere in the repo.

### TASK-23 — CI build matrix + release bundling · NFR-1, plan §8
**Depends on:** TASK-22 · **Unblocks:** —

**Context brief.** Prove cross-platform. GitHub Actions workflow: typecheck + unit tests +
`tauri build` on Windows, macOS, and Linux. Produce installers/bundles as release artifacts;
document unsigned-launch steps per OS (signing/notarization is post-v1, plan §7).

**Done when.** CI is green on all three OSes for a PR; a tagged release produces downloadable
bundles for each platform.
