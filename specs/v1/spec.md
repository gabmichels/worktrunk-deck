# worktrunk-deck — Specification

**Status:** draft · **Owner:** Gabriel Michels · **Last updated:** 2026-07-25

> **WHAT & WHY.** No implementation detail here (stack, files, and contracts live in
> [`plan.md`](./plan.md); the build order lives in [`tasks.md`](./tasks.md)).

## 1. Problem & context

[worktrunk](https://worktrunk.dev) (`git-wt`) is an excellent CLI for git-worktree-based
parallel development: it creates isolated worktrees, assigns each a stable non-colliding
dev-server port, and reports status via `git-wt list`. But it is terminal-only. When you have
many repos each with several active worktrees, there is no at-a-glance visual surface to see
everything running, spot which dev servers are live, and act on them.

**worktrunk-deck** is a cross-platform, open-source desktop dashboard that visualizes git
worktrees across all your repos and lets you act on them — create, run, merge, remove — with
an **integrated interactive terminal** for driving and watching dev servers. It is a pure
**view and controller over `git-wt`**: it owns no worktree/port logic of its own.

There is currently no desktop GUI for worktrunk; this fills that gap for the worktrunk
community and for anyone juggling many worktrees.

## 2. Goals

- Give a single, always-current visual overview of every worktree across all configured repos.
- Make the common worktree lifecycle (create → run → merge → remove) a click, not a
  remembered command.
- Let the user run and interact with dev servers **inside the app** via an integrated
  terminal, and optionally spin them out to an external terminal.
- Be genuinely cross-platform (Windows, macOS, Linux) and open-source from day one.
- Stay a thin layer: worktrunk remains the single source of truth for worktree/port state.

## 3. Non-goals

- **Not reimplementing worktrunk.** No port allocation, no worktree-creation logic of our
  own — every such operation delegates to `git-wt`. If worktrunk can't do it, neither do we.
- **Not a general git GUI.** No staging/committing/rebasing/diff-editing beyond the status
  `git-wt` already surfaces.
- **Not cross-repo feature orchestration.** worktrunk features are single-repo; v1 does
  **not** create coordinated multi-repo worktrees. Cross-repo grouping (§REQ-4) is a *display*
  convenience only, and the data model must not preclude adding real orchestration later.
- No cloud, teams, accounts, or auth. No telemetry. No mobile or web build.
- Not tied to one person's setup — no hardcoded repo list, paths, or personal data.

## 4. Users & scenarios

- *As a solo dev with many side projects, I want to see every worktree and which dev servers
  are live across all my repos in one window, so I stop hunting through terminals.*
- *As someone starting a new feature, I want to click "New worktree", name a branch, and have
  worktrunk set it up, so I skip the ceremony.*
- *As someone debugging, I want an interactive terminal rooted in a specific worktree where I
  can run the dev server and type commands, so I can watch logs and poke at it in place.*
- *As someone wrapping up, I want to merge a worktree to main and remove it with one action
  (with a confirmation), so cleanup isn't a chore.*

## 5. Functional requirements

- **REQ-1 — Repo discovery.** Discover repos from configuration: an explicit list of repo
  paths and/or auto-scan of a chosen root directory for git repositories. If none are
  configured, present a first-run setup flow.
- **REQ-2 — Worktree listing.** For each repo, list every worktree with: branch, filesystem
  path, dirty/clean state, uncommitted line diff, ahead/behind vs the default branch and vs
  the remote, HEAD commit (short sha + message), the dev-server URL, and whether that URL is
  currently listening.
- **REQ-3 — Aggregated single-repo view (default).** Aggregate all configured repos into one
  scrolling view. By default each worktree is represented as **one card** (single-repo). This
  is the default and leanest representation.
- **REQ-4 — Optional cross-repo grouping.** Provide an optional mode that groups worktrees
  sharing a feature/branch identity across repos into a single multi-repo card (one row per
  repo, à la the reference tool). Off by default; toggizable in settings.
- **REQ-5 — Create worktree.** Create a new worktree for a chosen repo from a branch name,
  delegating to `git-wt switch --create`. Show progress and refresh on completion.
- **REQ-6 — Per-worktree actions.** For each worktree: open an integrated terminal, run the
  dev server, merge into the default branch, remove the worktree, open in editor, open the
  dev-server URL, and copy the path.
- **REQ-7 — Integrated terminal sidebar (core).** Open an interactive PTY terminal session
  rooted in a worktree's directory; stream its output live; accept keyboard input; support
  multiple concurrent sessions (tabbed); allow running the repo's configured dev command in
  one. Sessions live for the app's lifetime and are clearly killed on quit.
- **REQ-8 — Run externally.** Optionally launch a worktree's dev command in the operating
  system's terminal instead of the integrated one.
- **REQ-9 — Isolated worktrees.** Surface worktrees not part of a tracked feature, grouped by
  repo, so nothing is invisible.
- **REQ-10 — Filter/search.** Filter the view by repo, branch, or feature via a text field.
- **REQ-11 — Refresh model.** Auto-refresh on a configurable interval, on window focus, and on
  manual refresh. A failed or slow refresh must **never blank the view** — show the last good
  data and a staleness indicator.
- **REQ-12 — Destructive-action confirmation.** Confirm before destructive actions (remove,
  merge), with a setting to disable the prompt.
- **REQ-13 — Settings.** Configure: repo list / scan root, `git-wt` binary path override,
  auto-refresh interval, external-terminal choice, confirm-destructive toggle, and theme.
  Settings persist locally and validate live (e.g. "workspace OK — N repos found").
- **REQ-14 — Help/legend.** A help panel explaining every status icon and action.
- **REQ-15 — Per-repo error isolation.** If `git-wt` fails or a repo is unreadable, surface
  that inline on the affected repo without breaking the rest of the view.

## 6. Non-functional requirements

- **NFR-1 — Platforms.** Must run on Windows, macOS, and Linux from a single codebase.
- **NFR-2 — Open source.** Permissive license (MIT or Apache-2.0); every dependency
  OSS-compatible; no proprietary assets, personal data, or hardcoded user paths.
- **NFR-3 — Security / least privilege.** The UI may only trigger an **allowlisted** set of
  `git-wt` subcommands and the user's configured dev commands. No arbitrary shell from the UI
  except the explicit, user-driven integrated terminal (rooted in a worktree dir). Any
  binary-path override is validated before use. Never read `.env*` files.
- **NFR-4 — Performance.** Listing across ~20 repos completes in ≲1s by invoking `git-wt` per
  repo in parallel; the UI never blocks on I/O; cold start < 2s.
- **NFR-5 — Resilience.** One slow or failing repo must not block or delay the others
  (independent, parallel loads; progressive rendering acceptable).
- **NFR-6 — Engine isolation.** worktrunk is the only engine dependency; confine all `git-wt`
  knowledge (invocation + JSON parsing) to a single adapter module so the contract has one
  home and could be swapped later. This is future-proofing, **not** a mandate to support
  multiple engines in v1.
- **NFR-7 — Accessibility & theming.** Keyboard-navigable; light and dark themes.

## 7. Acceptance criteria

- [ ] Fresh install with no config shows a first-run setup; after pointing it at a directory
      of git repos, the dashboard lists their worktrees. (REQ-1, REQ-13)
- [ ] Each worktree card shows dirty state, ahead/behind, HEAD, and a live/not-live dot that
      matches reality (start a dev server → dot goes live within one refresh). (REQ-2, REQ-11)
- [ ] "New worktree" creates a worktree via `git-wt` and it appears after refresh. (REQ-5)
- [ ] Opening the terminal on a worktree gives an interactive shell in that directory; running
      the dev command there starts the server and its logs stream in the panel. (REQ-7)
- [ ] Merge and Remove work through `git-wt` and prompt for confirmation unless disabled.
      (REQ-6, REQ-12)
- [ ] Killing `git-wt`'s PATH availability (simulate) surfaces a clear per-repo error, and the
      rest of the app still functions. (REQ-15, NFR-3)
- [ ] The app builds and runs on Windows, macOS, and Linux in CI. (NFR-1)
- [ ] Repository contains a permissive LICENSE and a README that lets a stranger build and run
      it. (NFR-2)

## 8. Open questions

- **Q1 — Config source of truth.** Own config file (`worktrunk-deck` config) listing repo
  roots, vs. reading worktrunk's own config, vs. pure directory scan. → Leaning: own small
  config with an optional scan root; resolve during `plan.md`/M1.
- **Q2 — Cross-repo grouping heuristic.** By exact branch-name match across repos, or an
  explicit feature manifest? → Defer; v1 ships single-repo default, grouping heuristic TBD.
- **Q3 — worktrunk JSON stability.** Which `git-wt` versions are supported, and how to detect
  a schema mismatch gracefully. → Pin a minimum version; adapter tolerates unknown fields.
- **Q4 — Editor/terminal targets per-OS.** Exact editor (`code`/`cursor`) and terminal
  (Windows Terminal/PowerShell, macOS Terminal/iTerm/Warp, Linux $TERMINAL) resolution. →
  Enumerate in `plan.md`.
