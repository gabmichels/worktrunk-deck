/**
 * Integrated terminal sidebar: session registry + tab strip + panes (TASK-15, REQ-7).
 *
 * `useTerminalSessions` owns the list of live PTY sessions so card actions elsewhere in the app
 * (outside files we own — App.tsx wires this in) can open a shell or a dev-server pane without
 * knowing anything about xterm. `TerminalSidebar` is the tab strip + pane host consuming that
 * controller.
 */
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/useConfig";
import { onPtyExit, ptyKill, ptyOpen } from "@/lib/ipc";
import type { SessionId, Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TerminalTab } from "./TerminalTab";

export interface TerminalSession {
  id: SessionId;
  /** e.g. "demo-app · feat/x" or "dev: feat/x". */
  title: string;
  cwd: string;
  worktreePath: string;
  repoPath: string;
  kind: "shell" | "dev";
  exited: boolean;
  exitCode: number | null;
}

/**
 * `devCommandByRepo` is keyed by whatever path shape the config author typed. worktrunk always
 * emits forward-slash paths on Windows (plan §3.2), but a human editing the config JSON by hand
 * might paste a backslash path from Explorer, and drive letters can vary in case — so match
 * case-insensitively after normalizing separators rather than requiring an exact string match.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function lookupDevCommand(
  devCommandByRepo: Record<string, string[]> | undefined,
  repoPath: string,
): string[] | undefined {
  if (!devCommandByRepo) return undefined;
  const target = normalizePath(repoPath);
  for (const [key, cmd] of Object.entries(devCommandByRepo)) {
    if (normalizePath(key) === target) return cmd;
  }
  return undefined;
}

function titleFor(w: Worktree, kind: "shell" | "dev"): string {
  return kind === "dev" ? `dev: ${w.branch}` : `${w.repo} · ${w.branch}`;
}

/** Owns the session list. Card actions call `openTerminal`/`runDev`; the sidebar renders it. */
export function useTerminalSessions() {
  const { config } = useConfig();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<SessionId | null>(null);
  const [pendingDevPrompt, setPendingDevPrompt] = useState<Worktree | null>(null);

  // One long-lived subscription marks any session exited, regardless of which tab is active or
  // mounted — TerminalTab also listens (to print the banner) but session bookkeeping lives here.
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = onPtyExit((e) => {
      if (disposed) return;
      setSessions((prev) =>
        prev.map((s) => (s.id === e.sessionId ? { ...s, exited: true, exitCode: e.code } : s)),
      );
    });
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const openSession = useCallback(
    async (w: Worktree, kind: "shell" | "dev", cmd?: string[]) => {
      const id = await ptyOpen(w.path, cmd);
      setSessions((prev) => [
        ...prev,
        {
          id,
          title: titleFor(w, kind),
          cwd: w.path,
          worktreePath: w.path,
          repoPath: w.repoPath,
          kind,
          exited: false,
          exitCode: null,
        },
      ]);
      setActiveId(id);
    },
    [],
  );

  const openTerminal = useCallback((w: Worktree) => openSession(w, "shell"), [openSession]);

  const runDev = useCallback(
    async (w: Worktree, cmdOverride?: string[]) => {
      const cmd = cmdOverride ?? lookupDevCommand(config.devCommandByRepo, w.repoPath);
      if (!cmd || cmd.length === 0) {
        // No configured command for this repo — ask instead of guessing (spec: don't guess).
        setPendingDevPrompt(w);
        return;
      }
      await openSession(w, "dev", cmd);
    },
    [config.devCommandByRepo, openSession],
  );

  const closeSession = useCallback(
    async (id: SessionId) => {
      await ptyKill(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveId((prev) => {
        if (prev !== id) return prev;
        const remaining = sessions.filter((s) => s.id !== id);
        return remaining.at(-1)?.id ?? null;
      });
    },
    [sessions],
  );

  const closeAll = useCallback(async () => {
    await Promise.all(sessions.map((s) => ptyKill(s.id)));
    setSessions([]);
    setActiveId(null);
  }, [sessions]);

  const submitDevPrompt = useCallback(
    async (cmd: string[]) => {
      const w = pendingDevPrompt;
      setPendingDevPrompt(null);
      if (!w || cmd.length === 0) return;
      await openSession(w, "dev", cmd);
    },
    [pendingDevPrompt, openSession],
  );

  return {
    sessions,
    activeId,
    setActiveId,
    openTerminal,
    runDev,
    closeSession,
    closeAll,
    // Internal to TerminalSidebar's prompt dialog — not part of the App.tsx contract, but
    // exposing it here keeps the dialog itself un-owned by any single tab/pane.
    pendingDevPrompt,
    submitDevPrompt,
    cancelDevPrompt: () => setPendingDevPrompt(null),
  };
}

/** A single-line shell command splitter good enough for "npm run dev -- --port 3000". */
function splitCommand(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function RunDevPromptDialog({
  worktree,
  onSubmit,
  onCancel,
}: {
  worktree: Worktree | null;
  onSubmit: (cmd: string[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue("");
  }, [worktree]);

  return (
    <Dialog open={worktree !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run dev command</DialogTitle>
          <DialogDescription>
            No dev command is configured for{" "}
            <span className="font-mono">{worktree?.repo}</span>. Enter one to run in{" "}
            <span className="font-mono">{worktree?.branch}</span>.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="pnpm dev"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onSubmit(splitCommand(value));
          }}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={() => onSubmit(splitCommand(value))}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TerminalTabButton({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-7 min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-2 text-[12px]",
        active
          ? "bg-card border-border text-foreground"
          : "border-transparent bg-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
        title={session.title}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            session.exited
              ? "bg-muted-foreground"
              : session.kind === "dev"
                ? "bg-live"
                : "bg-ok",
          )}
        />
        <span className="truncate font-mono">{session.title}</span>
        {session.exited && (
          <span className="shrink-0 text-muted-foreground">
            [{session.exitCode ?? "?"}]
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Close ${session.title}`}
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm opacity-0 group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function TerminalSidebar({
  controller,
  onCollapse,
}: {
  controller: ReturnType<typeof useTerminalSessions>;
  onCollapse: () => void;
}) {
  const {
    sessions,
    activeId,
    setActiveId,
    closeSession,
    closeAll,
    pendingDevPrompt,
    submitDevPrompt,
    cancelDevPrompt,
  } = controller;

  // Track sessions that have been closed so already-unmounted TerminalTabs don't get recreated
  // if a stale id ever slips back in — belt-and-suspenders, `sessions` is already filtered.
  const knownIds = useRef(new Set<string>());
  knownIds.current = new Set(sessions.map((s) => s.id));

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-border bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-background px-2 pt-1.5">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {sessions.map((s) => (
            <TerminalTabButton
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => setActiveId(s.id)}
              onClose={() => void closeSession(s.id)}
            />
          ))}
        </div>
        <Tooltip content="Close all terminals">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close all terminals"
            disabled={sessions.length === 0}
            onClick={() => void closeAll()}
          >
            <X className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Collapse terminal panel">
          <Button
            variant="ghost"
            size="sm"
            className="text-[12px]"
            aria-label="Collapse terminal panel"
            onClick={onCollapse}
          >
            Hide
          </Button>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            No terminals open — use a worktree card's "Open terminal" or "Run dev" action.
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="absolute inset-0">
              <TerminalTab sessionId={s.id} active={s.id === activeId} exited={s.exited} />
            </div>
          ))
        )}
      </div>

      <RunDevPromptDialog
        worktree={pendingDevPrompt}
        onSubmit={(cmd) => void submitDevPrompt(cmd)}
        onCancel={cancelDevPrompt}
      />
    </div>
  );
}
