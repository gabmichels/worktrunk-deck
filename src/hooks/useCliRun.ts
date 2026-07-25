/**
 * Subscribes to `cli-log` / `cli-log-end` for one streamed `git-wt` run (TASK-12).
 *
 * `create_worktree` / `merge_worktree` resolve with a `runId` as soon as the child process is
 * spawned, but output can start arriving before that promise resolves. If we `await begin()`
 * first and only then call `listen()`, the earliest lines are lost to a race. So `start()`
 * subscribes to both events *before* awaiting `begin()`, buffers everything by runId, and only
 * starts rendering once we learn which runId is ours.
 */
import { useCallback, useRef, useState } from "react";

import { onCliLog, onCliLogEnd } from "@/lib/ipc";

export interface CliRunLine {
  line: string;
  stream: "stdout" | "stderr";
}

export interface UseCliRun {
  runId: string | null;
  title: string;
  lines: CliRunLine[];
  running: boolean;
  exitCode: number | null;
  start: (title: string, begin: () => Promise<string>) => Promise<void>;
  clear: () => void;
}

export function useCliRun(): UseCliRun {
  const [runId, setRunId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<CliRunLine[]>([]);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Guards against a stale subscription from a previous `start()` call still being in flight
  // (e.g. the component re-renders and calls start() again) writing into the wrong run's state.
  const activeRunIdRef = useRef<string | null>(null);

  const start = useCallback(async (nextTitle: string, begin: () => Promise<string>) => {
    setTitle(nextTitle);
    setLines([]);
    setExitCode(null);
    setRunning(true);
    setRunId(null);
    activeRunIdRef.current = null;

    // Events for a runId we don't know yet are queued here until `begin()` resolves and tells
    // us which id is ours; everything else (a different run entirely) is dropped.
    let resolvedRunId: string | null = null;
    const pendingLines: CliRunLine[] = [];
    let pendingExit: number | null | undefined;

    const unlistenLog = await onCliLog((e) => {
      if (resolvedRunId === null) {
        pendingLines.push({ line: e.line, stream: e.stream });
        return;
      }
      if (e.runId !== resolvedRunId) return;
      setLines((prev) => [...prev, { line: e.line, stream: e.stream }]);
    });

    const unlistenEnd = await onCliLogEnd((e) => {
      if (resolvedRunId === null) {
        pendingExit = e.code;
        return;
      }
      if (e.runId !== resolvedRunId) return;
      setExitCode(e.code);
      setRunning(false);
      void unlistenLog();
      void unlistenEnd();
    });

    try {
      const id = await begin();
      resolvedRunId = id;
      activeRunIdRef.current = id;
      setRunId(id);

      const bufferedForUs = pendingLines; // events queued before we knew the id — assume ours,
      // since only one run is ever in flight per useCliRun instance.
      if (bufferedForUs.length > 0) {
        setLines((prev) => [...prev, ...bufferedForUs]);
      }
      if (pendingExit !== undefined) {
        setExitCode(pendingExit);
        setRunning(false);
        void unlistenLog();
        void unlistenEnd();
      }
    } catch (e) {
      setRunning(false);
      setLines((prev) => [
        ...prev,
        { line: e instanceof Error ? e.message : String(e), stream: "stderr" },
      ]);
      void unlistenLog();
      void unlistenEnd();
    }
  }, []);

  const clear = useCallback(() => {
    setRunId(null);
    setTitle("");
    setLines([]);
    setRunning(false);
    setExitCode(null);
  }, []);

  return { runId, title, lines, running, exitCode, start, clear };
}
