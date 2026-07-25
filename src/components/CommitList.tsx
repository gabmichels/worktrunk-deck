/**
 * The expanded card's commit history — rendered below the fixed grid row, never inside it, so
 * the per-repo colour-tint work on the collapsed columns has nothing to collide with.
 */
import { AlertTriangle, ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { UseCommits } from "@/hooks/useCommits";
import { relativeTime } from "@/lib/relativeTime";
import type { Commit } from "@/lib/types";

export function CommitList({ state }: { state: UseCommits }) {
  const { commits, loading, error, hasMore, loadMore } = state;

  return (
    <div
      className="border-border mt-1.5 space-y-0.5 border-t pt-1.5"
      // Rows are informational, not interactive — stop clicks here from bubbling to the card's
      // toggle handler so selecting commit text doesn't collapse it out from under the user.
      onClick={(e) => e.stopPropagation()}
    >
      {error ? (
        <div className="text-muted-foreground flex items-center gap-1.5 px-1 py-1 text-[11px]">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span>Could not load history: {error}</span>
        </div>
      ) : commits.length === 0 && !loading ? (
        <p className="text-muted-foreground px-1 py-1 text-[11px]">No commits yet.</p>
      ) : (
        commits.map((c) => <CommitRow key={c.sha} commit={c} />)
      )}

      {loading && (
        <div className="text-muted-foreground flex items-center gap-1.5 px-1 py-1 text-[11px]">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading commits…
        </div>
      )}

      {!loading && !error && hasMore && commits.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={loadMore}
        >
          <ChevronDown className="size-3" aria-hidden />
          Load more
        </Button>
      )}
    </div>
  );
}

function CommitRow({ commit }: { commit: Commit }) {
  return (
    <div className="flex items-baseline gap-2 px-1 py-0.5 text-[11px]">
      <span className="text-muted-foreground shrink-0 font-mono">{commit.shortSha}</span>
      <span className="min-w-0 flex-1 truncate" title={commit.message}>
        {commit.message}
      </span>
      <span className="text-muted-foreground shrink-0">{commit.author}</span>
      <span className="text-muted-foreground shrink-0">{relativeTime(commit.timestamp)}</span>
    </div>
  );
}
