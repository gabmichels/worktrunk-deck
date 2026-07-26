/**
 * One worktree, one card (REQ-3) — the default and leanest representation.
 *
 * Everything shown here comes from worktrunk verbatim (REQ-2). In particular the port and its
 * live/not-live dot are `url` / `url_active` from `git-wt list`; the deck never probes ports or
 * computes them itself (spec Non-goals).
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useState } from "react";

import { CommitList } from "@/components/CommitList";
import { StatusDot } from "@/components/StatusDot";
import { Tooltip } from "@/components/ui/tooltip";
import { useCommits } from "@/hooks/useCommits";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

export function WorktreeCard({
  worktree,
  actions,
  onSelect,
  selected = false,
}: {
  worktree: Worktree;
  /** Action affordances are injected so M1 can render the card with none (TASK-8 → TASK-11). */
  actions?: ReactNode;
  /** Called on activation so the surrounding list can track which repo is current. */
  onSelect?: (worktree: Worktree) => void;
  selected?: boolean;
}) {
  const w = worktree;
  const [expanded, setExpanded] = useState(false);
  // Lives at this level (not inside CommitList) so collapsing and re-expanding reuses the
  // already-fetched pages instead of refetching — CommitList only ever mounts while expanded.
  const commits = useCommits(w.path);

  const toggle = () => {
    // Selecting and expanding are the same gesture: picking a card is how you say "this is the
    // repo I am working in", and that is exactly the moment you also want to see its history.
    onSelect?.(w);
    const next = !expanded;
    setExpanded(next);
    if (next) commits.ensureLoaded();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter/Space activate the card like a button (NFR-7); Space's default is page scroll, so
    // it must be prevented here rather than left to the browser.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={onKeyDown}
      className={cn(
        "border-border bg-card group rounded-lg border px-3 py-2",
        "hover:border-ring/40 cursor-pointer transition-colors",
        // Deliberately understated — this marks context, it is not a destructive selection.
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <div
        className={cn(
          "grid items-center gap-x-4 gap-y-1",
          "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(12rem,2fr)_5.5rem_5rem_minmax(0,3fr)_auto_auto]",
        )}
      >
        <BranchCell worktree={w} />
        <GitCell worktree={w} />
        <AheadBehindCell worktree={w} />
        <HeadCell worktree={w} />
        <PortCell worktree={w} />
        {/* Actions live inside their own click-stopping wrapper — the menu and any links must
            act on the worktree, not toggle the card's expansion out from under the user. */}
        <div
          className="flex items-center justify-end gap-0.5"
          onClick={(e: MouseEvent) => e.stopPropagation()}
        >
          {actions}
        </div>
      </div>

      {expanded && <CommitList state={commits} />}
    </div>
  );
}

function BranchCell({ worktree: w }: { worktree: Worktree }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[13px] font-medium" title={w.branch}>
          {w.branch}
        </span>
        {w.isMain && (
          <span className="text-muted-foreground border-border rounded border px-1 text-[10px] leading-4">
            main
          </span>
        )}
      </div>
      <div className="text-muted-foreground truncate font-mono text-[11px]" title={w.path}>
        {w.path}
      </div>
    </div>
  );
}

function GitCell({ worktree: w }: { worktree: Worktree }) {
  const dirty = w.git === "dirty";
  const detail = dirty
    ? `+${w.diff.added} / −${w.diff.deleted} uncommitted`
    : "No uncommitted changes";

  return (
    <Tooltip content={detail}>
      <div className="hidden items-center gap-1.5 md:flex">
        <StatusDot tone={dirty ? "dirty" : "ok"} />
        <span className="text-[12px]">{dirty ? "dirty" : "clean"}</span>
      </div>
    </Tooltip>
  );
}

/**
 * Ahead/behind the default branch, with the tracking branch on the second line.
 * `remote: null` means the branch has no upstream at all — rendered as `—`, which is a
 * different fact from "0/0 in sync" (REQ-2).
 */
function AheadBehindCell({ worktree: w }: { worktree: Worktree }) {
  return (
    <Tooltip
      content={
        <div className="space-y-0.5">
          <div>
            vs main: {w.main.ahead} ahead, {w.main.behind} behind
          </div>
          <div>
            {w.remote
              ? `vs remote: ${w.remote.ahead} ahead, ${w.remote.behind} behind`
              : "No upstream branch"}
          </div>
        </div>
      }
    >
      <div className="hidden font-mono text-[12px] md:block">
        <div className={cn(isZero(w.main) && "text-muted-foreground")}>
          {w.main.ahead}/{w.main.behind}
        </div>
        <div className="text-muted-foreground text-[11px]">
          {w.remote ? `${w.remote.ahead}/${w.remote.behind}` : "—"}
        </div>
      </div>
    </Tooltip>
  );
}

function isZero(ab: { ahead: number; behind: number }) {
  return ab.ahead === 0 && ab.behind === 0;
}

function HeadCell({ worktree: w }: { worktree: Worktree }) {
  if (!w.head.shortSha) {
    return <div className="text-muted-foreground hidden text-[12px] md:block">—</div>;
  }
  return (
    <div className="hidden min-w-0 items-baseline gap-2 md:flex">
      <span className="text-muted-foreground shrink-0 font-mono text-[12px]">
        {w.head.shortSha}
      </span>
      <span className="text-muted-foreground truncate text-[12px]" title={w.head.message}>
        {w.head.message}
      </span>
    </div>
  );
}

/**
 * worktrunk assigns each branch a stable port; the dot says whether anything is listening on
 * it right now. Dimmed-with-no-dot means "assigned but idle" — the same convention as
 * `git-wt list` (REQ-2).
 */
function PortCell({ worktree: w }: { worktree: Worktree }) {
  if (!w.url) {
    return <span className="text-muted-foreground font-mono text-[12px]">—</span>;
  }
  const port = portOf(w.url);
  return (
    <Tooltip content={w.urlActive ? `${w.url} — listening` : `${w.url} — not listening`}>
      <div className="flex items-center gap-1.5">
        <StatusDot tone={w.urlActive ? "live" : "idle"} pulse={w.urlActive} />
        <span
          className={cn(
            "font-mono text-[12px]",
            w.urlActive ? "text-foreground" : "text-muted-foreground",
          )}
        >
          :{port}
        </span>
      </div>
    </Tooltip>
  );
}

/** `http://localhost:12107` → `12107`; falls back to the whole URL if it is not parseable. */
export function portOf(url: string): string {
  try {
    return new URL(url).port || url;
  } catch {
    return url;
  }
}
