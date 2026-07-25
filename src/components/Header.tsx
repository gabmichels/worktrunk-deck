/**
 * Top chrome (TASK-18, REQ-10). The running-count pill doubles as a filter toggle rather than
 * being purely informational — clicking "3 running" is a faster path to "show me what's live"
 * than reaching for the text filter.
 */
import { CircleHelp, CornerLeftUp, FolderOpen, Plus, RefreshCw, Settings } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useBusy } from "@/hooks/useBusy";
import { appVersion } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function Header({
  runningCount,
  totalCount,
  lastUpdated,
  isStale,
  runningOnly,
  onToggleRunningOnly,
  onRefresh,
  onNewWorktree,
  onOpenSettings,
  onOpenHelp,
  scanRoot,
  onPickFolder,
  onGoToParent,
}: {
  runningCount: number;
  totalCount: number;
  lastUpdated: number | null;
  isStale: boolean;
  runningOnly: boolean;
  onToggleRunningOnly: () => void;
  onRefresh: () => void;
  onNewWorktree: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  /** The folder currently being scanned; null when only explicit repos are configured. */
  scanRoot: string | null;
  onPickFolder: () => void;
  /** Undefined at a filesystem root, where there is nowhere left to go. */
  onGoToParent?: (() => void) | undefined;
}) {
  // Fetched once on mount rather than passed as a prop — it never changes for the life of the
  // running app, so it doesn't need to live in App.tsx's state.
  const { busy } = useBusy();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  return (
    <header className="border-border bg-card flex h-11 shrink-0 items-center gap-3 border-b px-3">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[13px] font-semibold">worktrunk-deck</span>
        {version && (
          <span className="text-muted-foreground font-mono text-[11px]">v{version}</span>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleRunningOnly}
        aria-pressed={runningOnly}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
          runningOnly
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:bg-accent",
        )}
      >
        <span className="bg-live inline-block size-1.5 rounded-full" aria-hidden />
        {runningCount} running
        <span className="text-muted-foreground/70">/ {totalCount}</span>
      </button>

      <div className="flex items-center gap-1.5">
        <Tooltip content={isStale ? "Last refresh failed — showing last known data" : "Refresh"}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="Refresh"
            className={cn(isStale && "text-warn")}
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
          </Button>
        </Tooltip>
        <span className="text-muted-foreground text-[11px]" aria-live="polite">
          {formatLastUpdated(lastUpdated, isStale)}
        </span>
      </div>

      {/* The folder being scanned, so it is always obvious which slice of the disk you are
          looking at — and switchable without a trip through Settings. */}
      <div className="flex min-w-0 items-center gap-1">
        <Tooltip content={scanRoot ? `Scanning ${scanRoot}` : "Choose a folder to scan"}>
          <Button
            variant="outline"
            size="sm"
            onClick={onPickFolder}
            className="h-6 max-w-[22rem] min-w-0 gap-1.5 px-2 font-normal"
          >
            <FolderOpen className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate font-mono text-[11px]">
              {scanRoot ?? "Select folder…"}
            </span>
          </Button>
        </Tooltip>
        {onGoToParent && (
          <Tooltip content="Go up one folder">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onGoToParent}
              aria-label="Go up one folder"
            >
              <CornerLeftUp className="size-3.5" />
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" onClick={onNewWorktree}>
          <Plus className="size-3.5" />
          New worktree
        </Button>
        <Tooltip content="Help">
          <Button variant="ghost" size="icon-sm" onClick={onOpenHelp} aria-label="Help">
            <CircleHelp className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Settings">
          <Button variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="Settings">
            <Settings className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function formatLastUpdated(lastUpdated: number | null, isStale: boolean): string {
  if (lastUpdated === null) return "never refreshed";
  const seconds = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
  const label =
    seconds < 5
      ? "just now"
      : seconds < 60
        ? `${seconds}s ago`
        : `${Math.round(seconds / 60)}m ago`;
  return isStale ? `stale — last ok ${label}` : `updated ${label}`;
}
