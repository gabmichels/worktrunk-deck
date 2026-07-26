# Working in this repo

Operating instructions for anyone — human or coding agent — making changes here. Vendor-neutral
on purpose; `CLAUDE.md` just points at this file.

For *what the app is and why*, read [`README.md`](./README.md). For the full specification, read
[`specs/v1/`](./specs/v1/) — `spec.md` (requirements), `plan.md` (architecture and contracts),
`tasks.md` (the original task breakdown, with context briefs).

---

## The two invariants

Everything else is negotiable. These are not.

**1. worktrunk is the source of truth.** The deck never allocates ports, computes worktree
paths, decides where a worktree lives, or runs `git` to mutate anything. It asks
[worktrunk](https://worktrunk.dev) (`git-wt`) and renders the answer. If worktrunk cannot do
something, neither do we — the fix belongs upstream, not here.

**2. worktrunk's JSON shape is known in exactly two files.** `src-tauri/src/gitwt.rs` builds and
spawns the commands; `src/lib/adapter.ts` parses the output into the app's own types. No
component, hook, or command handler anywhere else may read a raw worktrunk field. This is what
makes a worktrunk upgrade a two-file change instead of a hunt.

### Rules that follow from them

- **Only four subcommands may ever be spawned**: `list`, `switch`, `merge`, `remove`. Enforced
  by the `Subcommand` enum in `gitwt.rs`. The webview cannot spawn processes at all. Widening
  this set is a security decision — open an issue before writing the code.
- **`git` itself is called only from `src-tauri/src/git.rs`**, and only to read: `log` for commit history,
  `status` for the working-tree detail view, plus `rev-parse`/`symbolic-ref` to find the branch to compare against.
  worktrunk has no log subcommand, which is why this exists at all. Flags are fixed literals,
  the caller supplies only a path and two integers, and `--` terminates the argument list. Any
  future `git` need goes in that file under the same rules, or nowhere.
- **The adapter must never throw.** worktrunk ships on its own cadence; an unexpected field must
  degrade one card, not blank the dashboard. `test/fixtures/list.malformed.json` enforces this —
  extend it rather than loosening the test.
- **The app never runs a fix on the user's behalf.** When a repo fails with git's "dubious
  ownership" error we show the exact command with a copy button and offer a terminal. We do not
  execute it.
- **No personal data, ever.** No usernames, absolute home paths, or private repo names in
  fixtures, screenshots, or docs. Fixtures are sanitized to `example-user` / `demo-app`; the
  README screenshot is generated from throwaway repos at a neutral path.

---

## Setup

Requires [worktrunk](https://worktrunk.dev) ≥ 0.60, Node ≥ 22, pnpm, a Rust toolchain, and your
platform's [Tauri v2 system deps](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev      # run with hot reload
```

## Commands

```sh
pnpm typecheck                                  # tsc --noEmit
pnpm test                                       # vitest
pnpm bump <patch|minor|major|X.Y.Z>             # version bump, see below
pnpm tauri dev                                  # dev app + vite
pnpm tauri build                                # installers into src-tauri/target/release/bundle/

cd src-tauri
cargo test                                      # incl. real PTY sessions
cargo clippy --all-targets -- -D warnings       # CI gate
cargo fmt --check                               # CI gate
```

Run the typecheck, both test suites, clippy and fmt before opening a PR. CI runs all of them on
Windows, macOS and Linux.

> `cargo test` really does spawn shells in pseudo-terminals — the only way to prove ConPTY
> (Windows) and `openpty` (Unix) work. It needs no network and takes a few seconds.

## Layout

```
src/                     React frontend
  lib/adapter.ts         raw worktrunk JSON -> app types  (invariant 2)
  lib/ipc.ts             typed wrappers + zod validation of every backend call
  lib/types.ts           the types components render
  lib/gitStatus.ts       git's status letters -> the groups the detail modal renders
  hooks/                 useWorktrees (polling), useConfig, usePty, useCommits, useBusy
  components/            UI; ui/ holds the shadcn-style primitives
src-tauri/src/
  gitwt.rs               the ONLY place that spawns git-wt  (invariant 2)
  git.rs                 the ONLY place that calls git; read-only log + status
  pty.rs                 terminal sessions (portable-pty)
  config.rs              config persistence, repo discovery, git-wt resolution
  external.rs            open in editor / file manager / browser
  terminals.rs           the per-OS terminal catalogue: detect it, then launch it
  commands.rs            the #[tauri::command] surface — thin, no logic
test/fixtures/           recorded worktrunk output, sanitized
specs/v1/                the specification this was built from
```

**Data flow:** `commands.rs` → `gitwt.rs` fans `git-wt list` across repos in parallel and returns
*raw* rows → `ipc.ts` validates the envelope with zod → `adapter.ts` normalizes into `Worktree` →
components render. Rust does fan-out and error isolation; it deliberately does not interpret
worktrunk's fields, so the mapping stays one pure, fixture-tested function.

## Conventions

- **Commits follow [Conventional Commits](https://www.conventionalcommits.org)**: `feat:`,
  `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `test:`. The body explains *why*, especially
  when the reason is not obvious from the diff.
- **Comments explain why, not what.** Cite `REQ-`/`NFR-`/`TASK-` numbers when a decision traces
  to the spec.
- **Theme variables only** in CSS — `bg-card`, `text-muted-foreground`, `var(--ok)` etc. Never a
  hardcoded colour. Light and dark must both work.
- **Every icon-only button needs an `aria-label`**, and interactive elements must be keyboard
  reachable.

## Development workflow

This repo is developed the way it expects you to work: **one worktree per change**, created with
worktrunk itself.

```sh
git-wt switch --create feat/my-change
# ... work, commit ...
git-wt merge
```

`main` is the default branch and stays releasable. There is no `develop`.

---

## Versioning

**Semantic versioning.** Until 1.0.0, treat `0.MINOR.PATCH` as: minor = user-visible change,
patch = fix with no new surface.

| Change | Bump |
|---|---|
| Bug fix, docs, refactor, CI, dependency bump | `patch` |
| New feature, new setting, changed UI | `minor` |
| Breaking config change, dropped platform, changed CLI contract | `major` (post-1.0) |

**The version lives in `package.json` and nowhere else that you edit.** `tauri.conf.json` is set
to `"version": "../package.json"`, so bundle filenames and the version in the app header follow
it automatically. `src-tauri/Cargo.toml` carries a second copy only because a crate manifest
cannot reference JSON — `pnpm bump` writes both, and `pnpm test` fails if they ever drift.

```sh
pnpm bump patch      # 0.1.0 -> 0.1.1
pnpm bump minor      # 0.1.0 -> 0.2.0
pnpm bump 1.0.0      # explicit
```

`pnpm bump` intentionally does **not** commit or tag. Bumping and releasing are separate
decisions: you may want to bump, land a few more commits, then release.

## Releasing

A tag is what publishes. Nothing else does.

1. Make sure `main` is green — CI runs on every push, so check the latest run.
2. `pnpm bump <level>`
3. Commit it: `git commit -am "chore: release vX.Y.Z"`
4. Tag and push:
   ```sh
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. The tag triggers `.github/workflows/release.yml`, which builds Windows and Linux installers,
   publishes SHA256 checksums and signed build provenance, and creates a **draft** release.
6. Review the draft on GitHub, then publish it.

The release is a draft on purpose — the artifacts are worth eyeballing before anyone downloads
them.

**What ships and what does not.** Windows and Linux only. macOS builds fine in CI but is not
published: an unsigned bundle fails Gatekeeper with "worktrunk-deck is damaged and can't be
opened", and Homebrew removed `--no-quarantine` in 5.1, so a cask is no longer a workaround.
macOS users build from source, which sidesteps quarantine entirely. Re-adding macOS needs an
Apple Developer Program membership for a Developer ID certificate and notarization — not a Mac,
since the runners build it. See `release.yml`'s header comment for exactly what to restore.

**A tag is permanent.** If a release is wrong, bump again and cut a new one rather than moving
the tag — people may already have the artifacts, and the provenance attestation is bound to the
commit.

---

## Gotchas

- **`pnpm tauri dev` can die and leave the window open.** The app keeps showing the last bundle
  vite served, so edits appear to do nothing. If a change is not showing up, check that
  something is listening on port 1420 before debugging the code.
- **worktrunk only reports a dev-server URL for repos with `[list] url` in `.config/wt.toml`.**
  An empty port column usually means the repo is not configured, not that the deck is broken.
- **Sibling worktrees look like repos to a folder scan.** Discovery distinguishes them by `.git`
  being a *file* (linked worktree) rather than a directory. Get that wrong and every card in a
  repo duplicates.
- **A scan root that is itself a repo** resolves to that one repo rather than scanning children —
  that is how drilling into a single project works.
- **`process::command` hides the window; `windowed_command` shows it.** `CREATE_NO_WINDOW` on a
  Windows *console* program means no console at all, so a shell spawned with it runs headless —
  invisible, and impossible to type into. Anything the user is meant to see (an external
  terminal) must use `windowed_command`; anything they should not (`git-wt`, `git`) must not.
- **A terminal in `terminals.rs` must be detected, not assumed.** Entries are probed on disk and
  only offered in Settings if found. Adding one means writing both its `locate` and its `launch`
  — a start directory is spelled differently by almost every terminal.
- **PTY tests need a terminal-like handshake.** PowerShell's PSReadLine emits `ESC[6n` and blocks
  until something answers; xterm.js does this in the app, so the tests do it too. If a PTY test
  hangs with only that escape sequence captured, that is why.
