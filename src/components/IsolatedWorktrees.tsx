/**
 * Worktrees not part of a tracked cross-repo feature, grouped by repo (REQ-9). Whether a
 * worktree counts as "isolated" is decided by the caller (`grouping.ts#isIsolated`) — this
 * component only renders whatever list it is handed, so nothing here depends on
 * `config.crossRepoGrouping` at all.
 */
import { FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";

import { WorktreeCard } from "@/components/WorktreeCard";
import type { Worktree } from "@/lib/types";

export function IsolatedWorktrees({
  worktrees,
  renderActions,
}: {
  worktrees: Worktree[];
  renderActions?: (w: Worktree) => ReactNode;
}) {
  if (worktrees.length === 0) return null;

  const byRepo = groupByRepo(worktrees);

  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground px-1 text-[11px] font-semibold tracking-wide uppercase">
        Isolated worktrees
      </h2>
      {byRepo.map(([repoPath, repoName, rows]) => (
        <div key={repoPath} className="space-y-1.5">
          <header className="flex items-baseline gap-2 px-1">
            <FolderGit2 className="text-muted-foreground size-3.5 self-center" aria-hidden />
            <h3 className="font-mono text-[13px] font-semibold">{repoName}</h3>
            <span className="text-muted-foreground truncate font-mono text-[11px]" title={repoPath}>
              {repoPath}
            </span>
          </header>
          <div className="space-y-1.5">
            {rows.map((w) => (
              <WorktreeCard key={`${w.repoPath}::${w.branch}`} worktree={w} actions={renderActions?.(w)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** Preserves first-seen order of repos rather than resorting — matches the aggregated view above it. */
function groupByRepo(worktrees: Worktree[]): [repoPath: string, repoName: string, rows: Worktree[]][] {
  const order: string[] = [];
  const byRepo = new Map<string, Worktree[]>();
  for (const w of worktrees) {
    if (!byRepo.has(w.repoPath)) {
      byRepo.set(w.repoPath, []);
      order.push(w.repoPath);
    }
    byRepo.get(w.repoPath)!.push(w);
  }
  return order.map((repoPath) => {
    const rows = byRepo.get(repoPath)!;
    return [repoPath, rows[0]!.repo, rows];
  });
}
