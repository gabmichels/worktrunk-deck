/**
 * A multi-repo feature card: one row per repo sharing the same branch identity (REQ-4). Purely
 * a display grouping over already-fetched worktrees — rendering this never issues a git
 * operation across repos, and each row's actions still resolve to that one repo's `repoPath`
 * (spec Non-goals: no cross-repo orchestration).
 */
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";

import { WorktreeCard } from "@/components/WorktreeCard";
import type { FeatureGrouping } from "@/lib/grouping";
import type { Worktree } from "@/lib/types";

export function FeatureGroup({
  feature,
  renderActions,
}: {
  feature: FeatureGrouping;
  renderActions?: (w: Worktree) => ReactNode;
}) {
  return (
    <section className="border-border bg-accent/30 space-y-1.5 rounded-lg border border-dashed p-2">
      <header className="flex items-center gap-2 px-1">
        <GitBranch className="text-muted-foreground size-3.5" aria-hidden />
        <h2 className="font-mono text-[13px] font-semibold">{feature.feature}</h2>
        <span className="text-muted-foreground text-[11px]">
          {feature.worktrees.length} repos
        </span>
      </header>
      <div className="space-y-1.5">
        {feature.worktrees.map((w) => (
          <WorktreeCard key={`${w.repoPath}::${w.branch}`} worktree={w} actions={renderActions?.(w)} />
        ))}
      </div>
    </section>
  );
}
