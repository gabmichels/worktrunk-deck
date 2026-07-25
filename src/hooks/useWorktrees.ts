/**
 * The live-data hook (REQ-11).
 *
 * Polls `list_worktrees` on an interval, on window focus, and on demand. The load-bearing rule:
 * **a failed or slow poll never blanks the view.** We keep the last good snapshot and raise
 * `isStale` instead, because worktrunk momentarily unavailable (mid-`git-wt merge`, laptop
 * waking up) is normal and an empty dashboard would read as "all your worktrees are gone".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { toDeckSnapshot } from "@/lib/adapter";
import * as ipc from "@/lib/ipc";
import type { DeckSnapshot } from "@/lib/types";
import { messageOf } from "./useConfig";

/** After this long hidden, stop polling entirely; we refetch on focus anyway. */
const HIDDEN_PAUSE_MS = 30_000;

export interface UseWorktrees {
  snapshot: DeckSnapshot | null;
  /** True when the newest poll failed but we are still showing an older snapshot. */
  isStale: boolean;
  /** True only for the very first load, when there is nothing to show yet. */
  isLoading: boolean;
  /** The most recent poll error, kept alongside the stale data. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useWorktrees(autoRefreshMs: number, enabled = true): UseWorktrees {
  const [snapshot, setSnapshot] = useState<DeckSnapshot | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Guards against overlapping polls when a refresh outlives its interval. */
  const inFlight = useRef(false);
  /** Set on unmount so a late response cannot call setState on a dead component. */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = toDeckSnapshot(await ipc.listWorktrees(false));
      if (!alive.current) return;
      setSnapshot(next);
      setIsStale(false);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // Keep the previous snapshot on screen — this is the whole point of the hook.
      setError(messageOf(e));
      setIsStale(true);
    } finally {
      inFlight.current = false;
      if (alive.current) setIsLoading(false);
    }
  }, []);

  // Initial load + interval. `enabled` is false while the first-run gate is up, so we do not
  // hammer a backend we already know has no repos configured.
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void refresh();

    if (autoRefreshMs <= 0) return;

    let timer: number | undefined;
    let hiddenSince: number | null = null;

    const tick = () => {
      // Pause once the window has been hidden a while; focus will bring us back.
      if (document.hidden) {
        hiddenSince ??= Date.now();
        if (Date.now() - hiddenSince > HIDDEN_PAUSE_MS) return;
      } else {
        hiddenSince = null;
      }
      void refresh();
    };

    timer = window.setInterval(tick, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs, enabled, refresh]);

  // Refresh on focus regardless of the interval setting (REQ-11), including when auto-refresh
  // is switched off entirely.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  return { snapshot, isStale, isLoading, error, refresh };
}
