# `git-wt` fixtures

Real output from [worktrunk](https://worktrunk.dev), used to unit-test `src/lib/adapter.ts`
(plan §3.1 → §3.2). Paths, owners and repo names are **sanitized** — the deck ships no personal
data (NFR-2).

Captured with worktrunk **v0.60.0**.

| File | How it was produced |
|---|---|
| `list.basic.json` | `git-wt -C <repo> list --format json` against a repo with three worktrees: the main checkout (`is_main: true`), a sibling feature worktree, and a nested agent worktree under `.claude/worktrees/`. One dev server was listening on the second worktree's assigned port during capture, so exactly one row has `url_active: true`. |
| `list.full.json` | Same repo, `git-wt -C <repo> list --format json --full`. For this repo `--full` returned the same field set; it may add CI/summary fields on repos that have them, which the adapter must ignore rather than require. |
| `list.unreadable.json` | Hand-written. The shape the backend produces for a repo whose `git-wt` invocation failed — the real stderr text from pointing `git-wt` at a non-repository path. |
| `list.malformed.json` | Hand-written negative case: a `null` row, a string row, a row with no `branch`, a row with wrong-typed fields, and a valid row carrying **unknown future fields**. The adapter must skip the bad rows and keep the good ones without throwing (plan §8, Q3). |

## Shape notes learned from real output

These deviate from a naive reading of plan §3.1 and the adapter must handle them:

- **`main` is absent on the main worktree** (`is_main: true`) — there is nothing to compare against.
- **`remote` is absent** for branches with no upstream (the feature worktree in `list.basic.json` has none).
- `repo_url` exists alongside the structured `repo` object.
- `worktree.state` appears only in unusual states (e.g. `"branch_worktree_mismatch"`).
- `statusline` contains raw ANSI escapes; the deck renders its own status and ignores it.

## Re-capturing

```sh
git-wt -C /path/to/repo list --format json        > list.basic.json
git-wt -C /path/to/repo list --format json --full > list.full.json
```

Then sanitize: replace your GitHub owner, workspace directory and repo name with
`example-user`, `repos` and `demo-app`.
