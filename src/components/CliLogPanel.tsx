/**
 * Read-only streamed-output panel for a `useCliRun` (TASK-12, REQ-5).
 *
 * Superseded by the terminal sidebar in M3, but keeps create/merge usable before that lands:
 * this is the only place a user can watch `git-wt switch --create` / `git-wt merge` progress.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { UseCliRun } from "@/hooks/useCliRun";
import { cn } from "@/lib/utils";

export function CliLogPanel({ run, onClose }: { run: UseCliRun; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const notifiedRef = useRef(false);

  // Renders nothing when there is no run — the panel only exists while create/merge is
  // in flight or just finished (contract: `useCliRun()` with no start() called yet).
  const visible = run.runId !== null || run.running || run.lines.length > 0;

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.lines, autoScroll]);

  // Toast success/failure exactly once per completed run.
  useEffect(() => {
    if (run.running || run.exitCode === null || notifiedRef.current) return;
    notifiedRef.current = true;
    if (run.exitCode === 0) {
      toast.success(`${run.title || "Command"} finished`);
    } else {
      toast.error(`${run.title || "Command"} failed`, {
        description: lastStderr(run.lines),
      });
    }
  }, [run.running, run.exitCode, run.title, run.lines]);

  useEffect(() => {
    if (run.runId !== null || run.running) notifiedRef.current = false;
  }, [run.runId, run.running]);

  if (!visible) return null;

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Near the bottom counts as "still following"; scrolled up disables auto-scroll until the
    // user returns to the bottom themselves.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }

  return (
    <div className="border-border bg-card flex flex-col overflow-hidden rounded-lg border">
      <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium">{run.title || "Running…"}</span>
          {run.running && (
            <span className="text-muted-foreground text-[11px]">running…</span>
          )}
          {!run.running && run.exitCode !== null && (
            <span
              className={cn(
                "text-[11px]",
                run.exitCode === 0 ? "text-muted-foreground" : "text-destructive",
              )}
            >
              exit {run.exitCode}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close output panel"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-48 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed"
      >
        {run.lines.length === 0 && (
          <div className="text-muted-foreground italic">waiting for output…</div>
        )}
        {run.lines.map((l, i) => (
          <div
            key={i}
            className={cn("whitespace-pre-wrap", l.stream === "stderr" && "text-destructive")}
          >
            {l.line}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Best-effort failure summary for the toast — the last stderr line, else the last line at all. */
function lastStderr(lines: UseCliRun["lines"]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l?.stream === "stderr") return l.line;
  }
  return lines.at(-1)?.line;
}
