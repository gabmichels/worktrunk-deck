/**
 * A repo and its worktrees (REQ-3), or — when worktrunk could not read it — an inline error
 * row that leaves every other repo working (REQ-15).
 */
import { AlertTriangle, ChevronDown, Copy, EyeOff, FolderGit2, Terminal as TerminalIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { WorktreeCard } from "@/components/WorktreeCard";
import { repoAccentBorder, repoTintStyle } from "@/lib/repoColor";
import { diagnoseRepoError } from "@/lib/repoError";
import type { RepoResult, Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RepoSection({
  repo,
  worktrees,
  renderActions,
  onOpenTerminalAt,
  onHideRepo,
  onSelectRepo,
  selected = false,
}: {
  repo: RepoResult;
  /** Post-filter worktrees; the section renders what it is given (REQ-10). */
  worktrees: Worktree[];
  renderActions?: (worktree: Worktree) => ReactNode;
  /** Marks this repo as the current context — drives the "New worktree" default. */
  onSelectRepo?: (repoPath: string) => void;
  selected?: boolean;
  /** Opens a terminal at an arbitrary path — used to let the user run the fix manually (NFR-3). */
  onOpenTerminalAt?: (path: string) => void;
  /** Removes this repo from the dashboard without touching the config's `repos` list. */
  onHideRepo?: (repoPath: string) => void;
}) {
  return (
    // A deterministic per-repo tint (and accent bar) so repos are separable at a glance when
    // twenty of them scroll past. Kept very low chroma so text contrast is untouched (NFR-7).
    <section
      className={cn(
        "space-y-1.5 rounded-lg border-l-2 py-1 pl-2 transition-shadow",
        // Understated on purpose — this marks context, not a destructive selection. A ring
        // rather than a border change, so it does not fight the per-repo accent colour.
        selected && "ring-primary/50 bg-primary/[0.04] ring-1",
      )}
      style={{ ...repoTintStyle(repo.repoPath), ...repoAccentBorder(repo.repoPath) }}
      aria-current={selected ? "true" : undefined}
    >
      <header className="flex items-baseline gap-2 px-1">
        {/* The header is the click target rather than the whole section, so selecting a repo
            never competes with expanding one of its worktrees. */}
        <button
          type="button"
          onClick={() => onSelectRepo?.(repo.repoPath)}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left"
          title={selected ? "Current repository" : `Select ${repo.repo}`}
        >
          <FolderGit2 className="text-muted-foreground size-3.5 self-center" aria-hidden />
          <h2 className="font-mono text-[13px] font-semibold">{repo.repo}</h2>
          <span
            className="text-muted-foreground truncate font-mono text-[11px]"
            title={repo.repoPath}
          >
            {repo.repoPath}
          </span>
        </button>
      </header>

      {repo.load === "unreadable" ? (
        <RepoError
          repo={repo}
          onOpenTerminalAt={onOpenTerminalAt}
          onHideRepo={onHideRepo}
        />
      ) : worktrees.length === 0 ? (
        <p className="text-muted-foreground px-1 py-2 text-[12px]">No worktrees match.</p>
      ) : (
        <div className="space-y-1.5">
          {worktrees.map((w) => (
            <WorktreeCard
              key={`${w.repoPath}::${w.branch}`}
              worktree={w}
              actions={renderActions?.(w)}
              onSelect={(worktree) => onSelectRepo?.(worktree.repoPath)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RepoError({
  repo,
  onOpenTerminalAt,
  onHideRepo,
}: {
  repo: RepoResult;
  onOpenTerminalAt?: (path: string) => void;
  onHideRepo?: (repoPath: string) => void;
}) {
  const message = repo.error ?? "worktrunk could not read this repository.";
  const hint = diagnoseRepoError(message, repo.repoPath);
  // Collapsed by default: the plain-language title plus fix command usually says enough, but
  // the raw stderr must stay reachable, never hidden entirely (REQ-15).
  const [showDetails, setShowDetails] = useState(false);

  async function copyFix() {
    if (!hint.fixCommand) return;
    try {
      await navigator.clipboard.writeText(hint.fixCommand);
      toast.success("Command copied");
    } catch {
      toast.error("Could not copy command");
    }
  }

  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 flex items-start gap-2 rounded-lg border px-3 py-2"
    >
      <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[12px] font-medium">{hint.title}</p>

        {hint.fixCommand && (
          <div className="flex items-center gap-1.5">
            <code className="bg-background border-border min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-[11px]">
              {hint.fixCommand}
            </code>
            <Button
              variant="outline"
              size="icon-sm"
              className="size-6 shrink-0"
              onClick={() => void copyFix()}
              aria-label="Copy fix command"
            >
              <Copy className="size-3" />
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {onOpenTerminalAt && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onOpenTerminalAt(repo.repoPath)}
            >
              <TerminalIcon className="size-3" /> Open terminal here
            </Button>
          )}
          {onHideRepo && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onHideRepo(repo.repoPath)}
            >
              <EyeOff className="size-3" /> Hide this repo
            </Button>
          )}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-0.5 text-[11px]"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            Details
            <ChevronDown className={cn("size-3 transition-transform", showDetails && "rotate-180")} aria-hidden />
          </button>
        </div>

        {showDetails && (
          <pre className="text-muted-foreground border-border/60 mt-0.5 max-h-40 overflow-auto rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
            {message}
          </pre>
        )}
      </div>
    </div>
  );
}
