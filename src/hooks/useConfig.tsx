/**
 * App-wide access to the persisted {@link DeckConfig} (plan §3.3).
 *
 * Config is loaded once at startup and kept in context rather than re-read per component: the
 * refresh interval, the confirm-destructive toggle and the theme are read from many places, and
 * a stale copy in one of them would be a real bug.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import * as ipc from "@/lib/ipc";
import { DEFAULT_CONFIG, type DeckConfig, type GitWtResolution } from "@/lib/types";

interface ConfigContextValue {
  config: DeckConfig;
  /** False until the first load finishes — the first-run gate must not flash (TASK-20). */
  loaded: boolean;
  /** Populated when the config file itself could not be read. */
  error: string | null;
  /** Where `git-wt` was found, or why it wasn't. Null while the probe is in flight. */
  gitWt: GitWtResolution | null;
  save: (next: DeckConfig) => Promise<void>;
  /** Merge-and-save; the common case for a single settings toggle. */
  update: (patch: Partial<DeckConfig>) => Promise<void>;
  reload: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<DeckConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitWt, setGitWt] = useState<GitWtResolution | null>(null);

  const probeGitWt = useCallback(async () => {
    try {
      setGitWt(await ipc.resolveGitWt());
    } catch (e) {
      setGitWt({ ok: false, error: messageOf(e) });
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setConfig(await ipc.getConfig());
      setError(null);
    } catch (e) {
      // Keep whatever we had; a corrupt config should be reported, not silently reset.
      setError(messageOf(e));
    } finally {
      setLoaded(true);
    }
    await probeGitWt();
  }, [probeGitWt]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: DeckConfig) => {
      await ipc.setConfig(next);
      setConfig(next);
      setError(null);
      // The binary override lives in config, so re-probe after every save.
      await probeGitWt();
    },
    [probeGitWt],
  );

  const update = useCallback(
    (patch: Partial<DeckConfig>) => save({ ...config, ...patch }),
    [config, save],
  );

  const value = useMemo<ConfigContextValue>(
    () => ({ config, loaded, error, gitWt, save, update, reload }),
    [config, loaded, error, gitWt, save, update, reload],
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used inside <ConfigProvider>");
  return ctx;
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
