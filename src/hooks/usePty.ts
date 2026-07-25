/**
 * Binds a live PTY session to an xterm.js `Terminal` instance (TASK-14, REQ-7).
 *
 * This hook owns none of the terminal's lifecycle beyond the wiring: `TerminalTab` creates the
 * `Terminal`/`FitAddon`, this hook subscribes it to the matching PTY session's output, forwards
 * keystrokes back over `pty_write`, and keeps `pty_resize` in sync whenever the pane is fit to
 * its container. It does not call `ptyOpen`/`ptyKill` — session lifecycle is owned by
 * `useTerminalSessions` in `TerminalSidebar.tsx` so that switching tabs never tears down the
 * underlying shell.
 */
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect } from "react";

import { onPtyExit, onPtyOutput, ptyResize, ptyWrite } from "@/lib/ipc";
import type { SessionId } from "@/lib/types";

/**
 * Base64 → raw bytes, written straight into xterm. PTY output is chunked on arbitrary byte
 * boundaries, so decoding as UTF-8 text here would corrupt any multi-byte character split
 * across two chunks — xterm's own parser handles UTF-8 reassembly across `write()` calls when
 * fed `Uint8Array`s, a plain JS string cannot represent that.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface UsePtyOptions {
  /** Skip write/resize wiring once the session has already exited (still readable, but dead). */
  exited: boolean;
}

/**
 * Wires `term` to `sessionId`'s PTY. Call once per mounted `TerminalTab`; safe to call with a
 * `null` term while the xterm instance is still being constructed.
 */
export function usePty(
  sessionId: SessionId,
  term: Terminal | null,
  fitAddon: FitAddon | null,
  { exited }: UsePtyOptions,
): void {
  // Output: filter the shared event stream by sessionId — one listener per tab would also work,
  // but Tauri's `listen` already fans a single native event to every JS subscriber, so filtering
  // here is no more expensive and keeps the subscribe/unsubscribe symmetric per tab.
  useEffect(() => {
    if (!term) return;
    let disposed = false;
    const unlistenPromise = onPtyOutput((e) => {
      if (disposed || e.sessionId !== sessionId) return;
      term.write(base64ToBytes(e.base64Bytes));
    });
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sessionId, term]);

  // Input: keystrokes go straight to the PTY. Once the shell has exited there is nothing to
  // write to, so drop the subscription — the pane becomes read-only scrollback.
  useEffect(() => {
    if (!term || exited) return;
    const disposable = term.onData((data) => {
      void ptyWrite(sessionId, data);
    });
    return () => disposable.dispose();
  }, [sessionId, term, exited]);

  // Resize: fit on container change (ResizeObserver) and on window resize, then push the new
  // cols/rows to the PTY so the shell's own line-wrapping matches what's on screen.
  useEffect(() => {
    if (!term || !fitAddon || exited) return;
    const el = term.element?.parentElement;

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // Fit can throw if the container has zero size mid-transition (e.g. tab not yet
        // visible) — harmless, the next resize/visibility change will retry.
        return;
      }
      void ptyResize(sessionId, term.cols, term.rows);
    };

    fit();

    const resizeObserver = el ? new ResizeObserver(fit) : null;
    if (el && resizeObserver) resizeObserver.observe(el);
    window.addEventListener("resize", fit);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [sessionId, term, fitAddon, exited]);

  // Exit: nothing to do besides let the caller (TerminalTab) know via its own state — this hook
  // only needs the exit event to stop future writes, which the `exited` flag from the caller
  // already reflects (owned by useTerminalSessions, sourced from the same event).
  useEffect(() => {
    if (!term) return;
    let disposed = false;
    const unlistenPromise = onPtyExit((e) => {
      if (disposed || e.sessionId !== sessionId) return;
      term.write(`\r\n\x1b[2m[process exited${e.code === null ? "" : ` with code ${e.code}`}]\x1b[0m\r\n`);
    });
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sessionId, term]);
}
