/**
 * A single, always-on subscription to `pty-output`, with per-session buffering.
 *
 * # Why this exists
 *
 * A PTY starts talking the instant it is spawned, and Tauri events are not buffered. The
 * previous design subscribed inside `usePty`, which only runs after `pty_open` has resolved,
 * React has re-rendered, and the xterm instance exists — several ticks too late. Everything the
 * shell emitted in that window was dropped.
 *
 * That is not a cosmetic loss of a banner. A readline-style shell (PowerShell's PSReadLine,
 * and others) emits a Device Status Report — `ESC[6n` — on startup and **blocks until the
 * terminal answers** with the cursor position. xterm.js answers automatically, but only for
 * sequences it actually receives. Lose that one event and the shell hangs forever: the pane
 * shows a cursor and nothing else, and keystrokes vanish into a process that is not at a prompt.
 *
 * So the listener is installed before any session is opened, and output for a session with no
 * terminal attached yet is held until one arrives.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";

import { onPtyOutput } from "./ipc";
import type { SessionId } from "./types";

type Sink = (bytes: Uint8Array) => void;

/** Chunks received before a terminal attached, oldest first. */
const pending = new Map<SessionId, Uint8Array[]>();
const sinks = new Map<SessionId, Sink>();

let subscription: Promise<UnlistenFn> | null = null;

/**
 * Base64 → raw bytes. PTY output is chunked on arbitrary byte boundaries, so decoding as UTF-8
 * text here would corrupt any multi-byte character split across two chunks. xterm reassembles
 * UTF-8 across `write()` calls when fed `Uint8Array`s; a JS string cannot represent a partial
 * code point.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Starts listening. Idempotent, and **must be awaited before the first `pty_open`** — that is
 * the entire point. Safe to call repeatedly; only the first call subscribes.
 */
export function startPtyStream(): Promise<UnlistenFn> {
  subscription ??= onPtyOutput((e) => {
    const bytes = base64ToBytes(e.base64Bytes);
    const sink = sinks.get(e.sessionId);
    if (sink) {
      sink(bytes);
      return;
    }
    const queued = pending.get(e.sessionId);
    if (queued) queued.push(bytes);
    else pending.set(e.sessionId, [bytes]);
  });
  return subscription;
}

/**
 * Routes a session's output to `sink`, replaying anything that arrived beforehand. Replay
 * happens synchronously and in order, so the shell's startup sequence — including that
 * cursor-position query — reaches xterm exactly as if it had been listening all along.
 */
export function attachPtySink(sessionId: SessionId, sink: Sink): void {
  sinks.set(sessionId, sink);
  const queued = pending.get(sessionId);
  if (!queued) return;
  pending.delete(sessionId);
  for (const chunk of queued) sink(chunk);
}

/** Stops routing but keeps buffering — the pane may be remounting, not closing. */
export function detachPtySink(sessionId: SessionId): void {
  sinks.delete(sessionId);
}

/** Drops everything for a session. Call when it is closed, or the buffer leaks. */
export function forgetPtySession(sessionId: SessionId): void {
  sinks.delete(sessionId);
  pending.delete(sessionId);
}

/** Test seam — resets module state between cases. */
export function __resetPtyStreamForTests(): void {
  pending.clear();
  sinks.clear();
  subscription = null;
}

/** Test seam — how many chunks are held for a session. */
export function __pendingCount(sessionId: SessionId): number {
  return pending.get(sessionId)?.length ?? 0;
}
