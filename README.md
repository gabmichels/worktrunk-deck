# worktrunk-deck

A cross-platform, open-source desktop dashboard for [worktrunk](https://worktrunk.dev)
(`git-wt`) — visualize git worktrees across all your repos and drive them (create, run,
merge, remove) with an integrated interactive terminal. It is a thin **view and controller
over `git-wt`**; worktrunk remains the single source of truth for worktree and port state.

> **Status: specification only — not yet implemented.** This repo currently contains the
> full implementation spec. The app has not been built.

## Building this

The complete, self-contained spec lives in [`specs/v1/`](./specs/v1/). Read it in order:

1. **[`spec.md`](./specs/v1/spec.md)** — WHAT & WHY (requirements, non-goals, acceptance).
2. **[`plan.md`](./specs/v1/plan.md)** — HOW (architecture, stack, the `git-wt` JSON contract,
   Tauri/PTY command surface, module layout, milestones).
3. **[`tasks.md`](./specs/v1/tasks.md)** — DO (ordered, atomic, context-briefed tasks with a
   dependency graph). Start at TASK-1 and follow the graph.

Each task carries a context brief written so it can be executed **without the conversation
that produced this spec** — the repo plus these three docs are enough.

## Prerequisites (for the app, once built)

- [worktrunk](https://worktrunk.dev) (`git-wt`) installed and on PATH
- Node ≥ 22 + pnpm
- Rust toolchain (for the Tauri backend)

## Stack

Tauri v2 · React + Vite + TypeScript · Tailwind + shadcn/ui · xterm.js + `portable-pty` for
the integrated terminal. Cross-platform (Windows/macOS/Linux). See `specs/v1/plan.md` §2.

## License

To be added in TASK-22 (permissive — MIT or Apache-2.0).
