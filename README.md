# worktrunk-deck

A cross-platform, open-source desktop dashboard for [worktrunk](https://worktrunk.dev)
(`git-wt`) — visualize git worktrees across all your repos and drive them (create, run,
merge, remove) with an integrated interactive terminal. It is a thin **view and controller
over `git-wt`**; worktrunk remains the single source of truth for worktree and port state.

> **Status: work in progress — M1 (read-only dashboard) is done.** The dashboard lists real
> worktrees across every configured repo with live dev-server status. Lifecycle actions (M2),
> the integrated terminal (M3), and the full UI (M4) are not built yet. See
> [Roadmap](#roadmap).

## Quick start

**Prerequisites**

- [worktrunk](https://worktrunk.dev) (`git-wt`) ≥ 0.60, installed and on `PATH`
- Node ≥ 22 and [pnpm](https://pnpm.io)
- A [Rust toolchain](https://rustup.rs) (for the Tauri backend), plus your platform's
  [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)

**Run it**

```sh
pnpm install
pnpm tauri dev
```

**Build a bundle**

```sh
pnpm tauri build
```

**Configuration.** The deck reads a small JSON config from your OS app-config directory
(`%APPDATA%\dev.worktrunk.deck\config.json` on Windows,
`~/Library/Application Support/dev.worktrunk.deck/` on macOS,
`~/.config/dev.worktrunk.deck/` on Linux). Point `scanRoot` at a directory containing your
repos, or list them explicitly:

```json
{
  "version": 1,
  "repos": [],
  "scanRoot": "/path/to/your/repos",
  "autoRefreshMs": 5000,
  "confirmDestructive": true,
  "theme": "system",
  "crossRepoGrouping": false
}
```

A settings UI that writes this for you is TASK-19; until then, edit the file by hand. If
`git-wt` is not on the `PATH` your GUI session inherits, set `"gitWtPath"` to its absolute
path.

## Development

```sh
pnpm typecheck                 # tsc --noEmit
pnpm test                      # vitest — adapter unit tests against recorded fixtures
cd src-tauri && cargo test     # config, git-wt allowlist, fan-out
```

The `git-wt` JSON fixtures in [`test/fixtures/`](./test/fixtures/) are real, sanitized
worktrunk output; see that directory's README for how to re-capture them.

**Architecture in one line:** a Rust broker (`src-tauri/src/gitwt.rs`) invokes an allowlisted
set of `git-wt` subcommands per repo in parallel, and `src/lib/adapter.ts` normalizes the raw
JSON into the types the React UI renders. No worktree or port logic lives in this app.

## Design notes

- **Only four `git-wt` subcommands** may ever be spawned — `list`, `switch`, `merge`,
  `remove` — enforced in Rust. The webview cannot spawn processes at all.
- **A failed refresh never blanks the view.** The last good snapshot stays on screen with a
  staleness indicator.
- **One unreadable repo never breaks the others.** It renders as an inline error card.

## Roadmap

The complete, self-contained spec lives in [`specs/v1/`](./specs/v1/):

1. **[`spec.md`](./specs/v1/spec.md)** — WHAT & WHY (requirements, non-goals, acceptance).
2. **[`plan.md`](./specs/v1/plan.md)** — HOW (architecture, stack, the `git-wt` JSON contract,
   Tauri/PTY command surface, module layout, milestones).
3. **[`tasks.md`](./specs/v1/tasks.md)** — DO (ordered, atomic, context-briefed tasks with a
   dependency graph).

| Milestone | Scope | Status |
|---|---|---|
| M0 | Scaffold, types, fixtures | ✅ done |
| M1 | Read-only dashboard | ✅ done |
| M2 | Lifecycle actions (create / merge / remove) | ⬜ next |
| M3 | Integrated PTY terminal | ⬜ |
| M4 | Full UI (header, filter, settings, help, grouping) | ⬜ |
| M5 | OSS hardening (CI matrix, release bundles) | ⬜ |

Each task in `tasks.md` carries a context brief written so it can be executed **without the
conversation that produced the spec** — the repo plus those three docs are enough.

## Contributing

Issues and pull requests are welcome. Please keep the two invariants above intact: worktrunk
stays the source of truth, and all `git-wt` knowledge stays inside `gitwt.rs` and `adapter.ts`.

## Stack

Tauri v2 · React 19 + Vite + TypeScript · Tailwind v4 · xterm.js + `portable-pty` for the
integrated terminal. Windows, macOS, Linux.

## License

[MIT](./LICENSE)
