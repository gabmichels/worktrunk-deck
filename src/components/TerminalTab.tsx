/**
 * A single xterm.js pane bound to one PTY session (TASK-14, REQ-7).
 *
 * `TerminalSidebar` keeps every open session's `TerminalTab` mounted at all times and toggles
 * `hidden` on the inactive ones — unmounting on tab-switch would tear down the xterm instance
 * (and, if it drove `ptyKill` in a cleanup effect, the shell itself) just because the user
 * looked away. Only `closeSession` in `useTerminalSessions` is allowed to kill a session; this
 * component never calls `ptyKill`.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import { usePty } from "@/hooks/usePty";
import { cn } from "@/lib/utils";
import type { SessionId } from "@/lib/types";

/** Reads a CSS custom property off `:root`/`.dark` so the terminal follows the app theme live. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm's `ITheme` wants concrete colors, not a stylesheet — so we snapshot the current theme's
 * CSS variables into one. `oklch()` is a valid CSS color value in the Chromium engine Tauri's
 * WebView2 ships, so passing the variables straight through works in both light and dark
 * without re-deriving a palette here (NFR-7).
 */
function readXtermTheme() {
  return {
    background: cssVar("--card"),
    foreground: cssVar("--card-foreground"),
    cursor: cssVar("--primary"),
    cursorAccent: cssVar("--card"),
    selectionBackground: cssVar("--accent"),
    black: cssVar("--foreground"),
    brightBlack: cssVar("--muted-foreground"),
  };
}

export interface TerminalTabProps {
  sessionId: SessionId;
  /** Panes for inactive tabs stay mounted (see file header) but are hidden via CSS. */
  active: boolean;
  exited: boolean;
}

export function TerminalTab({ sessionId, active, exited }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);

  // Construct the xterm instance once per session and dispose it only when this TerminalTab
  // itself unmounts (i.e. the session was closed) — not on active/inactive toggles.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const t = new Terminal({
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace",
      cursorBlink: true,
      allowProposedApi: true,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(container);

    setTerm(t);
    setFitAddon(fit);

    return () => {
      t.dispose();
      setTerm(null);
      setFitAddon(null);
    };
    // sessionId never changes for a mounted TerminalTab (App/useTerminalSessions keys panes by
    // it), so this effect is correctly once-per-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-theme: re-apply xterm's theme when the app theme flips (class toggle on <html>), so an
  // already-open terminal doesn't stay light-themed after switching to dark or vice versa.
  useEffect(() => {
    if (!term) return;
    const observer = new MutationObserver(() => {
      term.options.theme = readXtermTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [term]);

  usePty(sessionId, term, fitAddon, { exited });

  // Fit whenever this pane becomes the active/visible one — a hidden pane has zero layout size,
  // so `fit()` while inactive would compute a bogus 0x0 and desync the PTY's idea of the size.
  useEffect(() => {
    if (!active || !fitAddon || !term) return;
    try {
      fitAddon.fit();
    } catch {
      // Container may briefly have no size right at the visibility flip; harmless.
    }
  }, [active, fitAddon, term]);

  return (
    <div
      className={cn("h-full w-full overflow-hidden bg-card p-2", !active && "hidden")}
      aria-hidden={!active}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
