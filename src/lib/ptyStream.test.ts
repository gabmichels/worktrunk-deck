/**
 * These guard the bug that made the terminal panel unusable: output emitted between `pty_open`
 * and the pane mounting was dropped, so PowerShell's startup `ESC[6n` never reached xterm, xterm
 * never answered, and the shell blocked forever showing a bare cursor.
 *
 * The whole point of `ptyStream` is that nothing emitted after `startPtyStream()` can be lost,
 * however late a terminal attaches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: ((e: { sessionId: string; base64Bytes: string }) => void)[] = [];

vi.mock("./ipc", () => ({
  onPtyOutput: (handler: (e: { sessionId: string; base64Bytes: string }) => void) => {
    listeners.push(handler);
    return Promise.resolve(() => {});
  },
}));

const {
  startPtyStream,
  attachPtySink,
  detachPtySink,
  forgetPtySession,
  __resetPtyStreamForTests,
  __pendingCount,
} = await import("./ptyStream");

/** Simulates the backend emitting a chunk of PTY output. */
function emit(sessionId: string, text: string) {
  const base64 = btoa(text);
  for (const listener of listeners) listener({ sessionId, base64Bytes: base64 });
}

function decode(chunks: Uint8Array[]): string {
  return chunks.map((c) => new TextDecoder().decode(c)).join("");
}

beforeEach(() => {
  listeners.length = 0;
  __resetPtyStreamForTests();
});

describe("ptyStream", () => {
  it("replays output that arrived before the terminal attached", async () => {
    await startPtyStream();

    // The shell starts talking immediately — this is the window the old code lost.
    emit("pty-0", "\u001b[6n");
    emit("pty-0", "PS C:\\> ");
    expect(__pendingCount("pty-0")).toBe(2);

    const received: Uint8Array[] = [];
    attachPtySink("pty-0", (b) => received.push(b));

    expect(decode(received)).toBe("\u001b[6nPS C:\\> ");
    expect(__pendingCount("pty-0")).toBe(0);
  });

  it("streams live once attached", async () => {
    await startPtyStream();
    const received: Uint8Array[] = [];
    attachPtySink("pty-0", (b) => received.push(b));

    emit("pty-0", "hello");
    expect(decode(received)).toBe("hello");
  });

  it("keeps sessions separate", async () => {
    await startPtyStream();
    emit("pty-0", "for zero");
    emit("pty-1", "for one");

    const zero: Uint8Array[] = [];
    const one: Uint8Array[] = [];
    attachPtySink("pty-0", (b) => zero.push(b));
    attachPtySink("pty-1", (b) => one.push(b));

    expect(decode(zero)).toBe("for zero");
    expect(decode(one)).toBe("for one");
  });

  it("subscribes exactly once however often it is started", async () => {
    await startPtyStream();
    await startPtyStream();
    await startPtyStream();
    // A second subscription would deliver every chunk twice — visible as doubled output.
    expect(listeners).toHaveLength(1);
  });

  it("buffers again after detach, so a remounting pane loses nothing", async () => {
    await startPtyStream();
    const received: Uint8Array[] = [];
    attachPtySink("pty-0", (b) => received.push(b));

    detachPtySink("pty-0");
    emit("pty-0", "while detached");
    expect(__pendingCount("pty-0")).toBe(1);

    attachPtySink("pty-0", (b) => received.push(b));
    expect(decode(received)).toBe("while detached");
  });

  it("drops everything for a forgotten session, so buffers cannot leak", async () => {
    await startPtyStream();
    emit("pty-0", "orphaned");
    expect(__pendingCount("pty-0")).toBe(1);

    forgetPtySession("pty-0");
    expect(__pendingCount("pty-0")).toBe(0);

    emit("pty-0", "still orphaned");
    // Buffering resumes for unknown sessions, but the old chunks are gone for good.
    expect(__pendingCount("pty-0")).toBe(1);
  });

  it("preserves bytes exactly, including multi-byte characters split across chunks", async () => {
    await startPtyStream();
    const received: Uint8Array[] = [];
    attachPtySink("pty-0", (b) => received.push(b));

    // "é" is 0xC3 0xA9 — split across two events, as a real PTY read boundary can do.
    for (const listener of listeners) {
      listener({ sessionId: "pty-0", base64Bytes: btoa("\u00c3") });
      listener({ sessionId: "pty-0", base64Bytes: btoa("\u00a9") });
    }

    const joined = new Uint8Array(received.reduce<number[]>((a, c) => [...a, ...c], []));
    expect(Array.from(joined)).toEqual([0xc3, 0xa9]);
    expect(new TextDecoder().decode(joined)).toBe("é");
  });
});
