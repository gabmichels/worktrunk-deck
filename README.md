# worktrunk-deck

A cross-platform, open-source desktop dashboard for [worktrunk](https://worktrunk.dev)
(`git-wt`) — visualize git worktrees across all your repos and drive them (create, run,
merge, remove) with an integrated interactive terminal. It is a thin **view and controller
over `git-wt`**; worktrunk remains the single source of truth for worktree and port state.

![worktrunk-deck showing three repositories, their worktrees, and a live dev server](./docs/screenshot.png)

> **Status: feature-complete for v1 (M0–M5).** Everything in [`specs/v1/`](./specs/v1/) is
> implemented. It has been exercised end-to-end on Windows; macOS and Linux build in CI but
> have not yet had a manual pass (see [Roadmap](#roadmap)).

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

On first run the app walks you through this — there is no need to write the file by hand. If
`git-wt` is not on the `PATH` your GUI session inherits (common on macOS and Linux, where GUI
apps get a minimal environment), set `"gitWtPath"` to its absolute path, or use the Browse
button in Settings.

### Making the port column work

The **port** column and its live/idle dot come straight from worktrunk, which only assigns a
dev-server URL to a repo that asks for one. If every row shows `—`, add a `.config/wt.toml` to
that repo:

```toml
[list]
url = "http://localhost:{{ branch | hash_port }}"

[aliases]
dev = "pnpm dev --port {{ branch | hash_port }}"
```

`hash_port` derives a stable port in 10000–19999 from the branch name, so every worktree gets
its own and two worktrees on the same branch share one. The deck only *displays* this — it
never allocates ports itself.

## Installing an unsigned build

v1 releases are **unsigned** — code signing and notarization are post-v1. Your OS will object
the first time:

- **macOS** — "worktrunk-deck is damaged and can't be opened" is Gatekeeper, not a corrupt
  download. Clear the quarantine flag:
  ```sh
  xattr -dr com.apple.quarantine "/Applications/worktrunk-deck.app"
  ```
- **Windows** — SmartScreen shows "Windows protected your PC". Choose **More info → Run
  anyway**.
- **Linux** — mark the AppImage executable: `chmod +x worktrunk-deck_*.AppImage`.

Building from source (above) avoids all of this.

## Development

```sh
pnpm typecheck                 # tsc --noEmit
pnpm test                      # vitest — adapter + grouping units against recorded fixtures
cd src-tauri && cargo test     # config, git-wt allowlist, fan-out, and real PTY sessions
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo fmt --check
```

The last two are enforced in CI, so run them before opening a PR.

Note that `cargo test` really does spawn shells in real pseudo-terminals — that is the only
way to prove ConPTY (Windows) and `openpty` (Unix) work. Those tests take a few seconds and
need no network.

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
| M2 | Lifecycle actions (create / merge / remove) | ✅ done |
| M3 | Integrated PTY terminal | ✅ done |
| M4 | Full UI (header, filter, settings, help, grouping) | ✅ done |
| M5 | OSS hardening (CI matrix, release bundles) | ✅ done |

Each task in `tasks.md` carries a context brief written so it can be executed **without the
conversation that produced the spec** — the repo plus those three docs are enough.

### Known gaps

Honest list of what v1 does *not* have:

- **Manual verification is Windows-only so far.** CI builds and runs the test suite on all
  three platforms, but nobody has yet clicked through the app on macOS or Linux. The
  per-OS terminal and "run externally" paths are the most likely places to find problems.
- **Releases are unsigned.** Signing and notarization are post-v1 (plan §7).
- **Cross-repo grouping is display-only and uses a naive heuristic** (exact branch-name match
  across repos). Spec Q2 leaves a manifest-based approach open; the heuristic is isolated in
  `src/lib/grouping.ts` so it can be replaced without touching callers.
- **`--full` is not surfaced in the UI.** The backend supports it; nothing requests it yet.

## Contributing

Issues and pull requests are welcome. Two invariants matter more than anything else — please
keep them intact:

1. **worktrunk stays the source of truth.** The deck never allocates ports, computes worktree
   paths, or runs raw `git`. If worktrunk cannot do it, neither do we.
2. **All `git-wt` knowledge lives in two files** — `src-tauri/src/gitwt.rs` (invocation) and
   `src/lib/adapter.ts` (parsing). Nothing else should know worktrunk's JSON shape.

Practical notes:

- Only four subcommands are allowlisted (`list`, `switch`, `merge`, `remove`). Widening that
  set is a security decision, not a refactor — raise it in an issue first.
- The adapter must never throw on unexpected input. `test/fixtures/list.malformed.json` exists
  to enforce that; add to it rather than loosening the test.
- Run the commands under [Development](#development) before opening a PR.

## Stack

Tauri v2 · React 19 + Vite + TypeScript · Tailwind v4 · xterm.js + `portable-pty` for the
integrated terminal. Windows, macOS, Linux.

## License

[MIT](./LICENSE)
