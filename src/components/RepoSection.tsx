/**
 * A repo and its worktrees (REQ-3), or — when worktrunk could not read it — an inline error
 * row that leaves every other repo working (REQ-15).
 */
import { AlertTriangle, FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";

import { WorktreeCard } from "@/components/WorktreeCard";
import type { RepoResult, Worktree } from "@/lib/types";

export function RepoSection({
  repo,
  worktrees,
  renderActions,
}: {
  repo: RepoResult;
  /** Post-filter worktrees; the section renders what it is given (REQ-10). */
  worktrees: Worktree[];
  renderActions?: (worktree: Worktree) => ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <header className="flex items-baseline gap-2 px-1">
        <FolderGit2 className="text-muted-foreground size-3.5 self-center" aria-hidden />
        <h2 className="font-mono text-[13px] font-semibold">{repo.repo}</h2>
        <span
          className="text-muted-foreground truncate font-mono text-[11px]"
          title={repo.repoPath}
        >
          {repo.repoPath}
        </span>
      </header>

      {repo.load === "unreadable" ? (
        <RepoError message={repo.error ?? "worktrunk could not read this repository."} />
      ) : worktrees.length === 0 ? (
        <p className="text-muted-foreground px-1 py-2 text-[12px]">No worktrees match.</p>
      ) : (
        <div className="space-y-1.5">
          {worktrees.map((w) => (
            <WorktreeCard key={`${w.repoPath}::${w.branch}`} worktree={w} actions={renderActions?.(w)} />
          ))}
        </div>
      )}
    </section>
  );
}

function RepoError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 flex items-start gap-2 rounded-lg border px-3 py-2"
    >
      <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-[12px] font-medium">This repository could not be read.</p>
        <pre className="text-muted-foreground mt-0.5 font-mono text-[11px] break-words whitespace-pre-wrap">
          {message}
        </pre>
      </div>
    </div>
  );
}
