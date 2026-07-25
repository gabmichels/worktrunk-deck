/**
 * App-wide "something is happening" state.
 *
 * Most of what the deck does is fast enough to need no feedback, but a few operations reach the
 * filesystem or spawn worktrunk and can take a noticeable moment — switching to a folder with
 * many repos, a manual refresh, saving settings. Without an indicator those read as a frozen
 * window, so anything that might outlast a frame gets wrapped in {@link useBusy}'s `track`.
 *
 * A counter rather than a boolean: two operations can overlap (a refresh landing while a save
 * is in flight), and the indicator must stay up until the *last* one finishes.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface BusyContextValue {
  busy: boolean;
  /** What is happening, for the label beside the bar. Null when idle. */
  label: string | null;
  /** Runs `fn`, keeping the indicator up until it settles — including on failure. */
  track: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
}

const BusyContext = createContext<BusyContextValue | null>(null);

/**
 * Once shown, the indicator stays up this long even if the work already finished.
 *
 * Most operations here complete in well under 100ms, and a bar that appears and vanishes
 * within a frame or two reads as a glitch rather than feedback — worse than showing nothing.
 * Holding it briefly makes it legible without making the app feel slower than it is.
 */
const MIN_VISIBLE_MS = 400;

export function BusyProvider({ children }: { children: ReactNode }) {
  // Keyed by a per-call id so two operations sharing a label cannot remove each other's entry.
  const [active, setActive] = useState<{ id: number; label: string }[]>([]);
  const [held, setHeld] = useState(false);
  const nextId = useRef(0);

  const track = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const id = nextId.current++;
    setActive((prev) => [...prev, { id, label }]);
    setHeld(true);
    const shownAt = Date.now();
    try {
      return await fn();
    } finally {
      setActive((prev) => prev.filter((entry) => entry.id !== id));
      const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt);
      if (remaining > 0) window.setTimeout(() => setHeld(false), remaining);
      else setHeld(false);
    }
  }, []);

  const value = useMemo<BusyContextValue>(
    // The newest operation wins the label; when it finishes, an outer one's label returns
    // rather than the bar sitting there unlabelled.
    () => ({
      busy: active.length > 0 || held,
      label: active.at(-1)?.label ?? null,
      track,
    }),
    [active, held, track],
  );

  return <BusyContext.Provider value={value}>{children}</BusyContext.Provider>;
}

export function useBusy(): BusyContextValue {
  const ctx = useContext(BusyContext);
  if (!ctx) throw new Error("useBusy must be used inside <BusyProvider>");
  return ctx;
}
