import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import {
  readTerminalOutput,
  resizeTerminalSession,
  writeTerminalInput,
  type RuntimeConfig,
} from "#/lib/runtime-api";

const POLL_IDLE_MS = 150;
const POLL_RETRY_MS = 1000;
const FLUSH_MS = 25;
/** Input per request is bounded by the server; larger pastes are sent in pieces. */
const INPUT_PIECE = 8 * 1024;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * One terminal session in the page: xterm.js draws it, the Platform's terminal routes carry it.
 * Output is read by polling a cursor, input is batched for a few milliseconds, and a lost place
 * (a reload, a rotated output file) arrives as a screen to redraw. The session lives in tmux on the
 * server, so leaving this view closes nothing.
 */
export function TerminalView({ runtime, sessionId, onEnded }: { runtime: RuntimeConfig; sessionId: string; onEnded: (reason: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const stop = new AbortController();
    let disposed = false;
    const cleanups: Array<() => void> = [() => stop.abort()];

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13,
        scrollback: 5000,
        theme: { background: "#0b0d10", foreground: "#e6e6e6" },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      cleanups.push(() => terminal.dispose());
      terminal.focus();

      let pending = "";
      let flushing = false;
      const flush = async () => {
        if (flushing) return;
        flushing = true;
        try {
          while (pending && !stop.signal.aborted) {
            const piece = pending.slice(0, INPUT_PIECE);
            pending = pending.slice(piece.length);
            try {
              await writeTerminalInput(runtime, sessionId, piece, stop.signal);
            } catch (error) {
              if (!stop.signal.aborted) onEnded(error instanceof Error ? error.message : String(error));
              return;
            }
          }
        } finally {
          flushing = false;
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const typed = terminal.onData((data) => {
        pending += data;
        if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, FLUSH_MS);
      });
      cleanups.push(() => { typed.dispose(); if (timer) clearTimeout(timer); });

      let lastSize = "";
      const resize = () => {
        try { fit.fit(); } catch { return; }
        const size = `${terminal.cols}x${terminal.rows}`;
        if (size === lastSize) return;
        lastSize = size;
        void resizeTerminalSession(runtime, sessionId, { cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      cleanups.push(() => observer.disconnect());
      resize();

      // Read until the session ends or the view goes away.
      let cursor: string | undefined;
      while (!stop.signal.aborted) {
        try {
          const output = await readTerminalOutput(runtime, sessionId, cursor, stop.signal);
          cursor = output.cursor;
          if (output.reset) terminal.reset();
          if (output.data) terminal.write(Uint8Array.from(atob(output.data), (character) => character.charCodeAt(0)));
          if (!output.more) await sleep(POLL_IDLE_MS, stop.signal);
        } catch (error) {
          if (stop.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/ended|No such terminal session/i.test(message)) { onEnded("This terminal session has ended."); return; }
          setProblem(message);
          await sleep(POLL_RETRY_MS, stop.signal);
          setProblem(undefined);
        }
      }
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, [runtime, sessionId, onEnded]);

  return (
    <div className="grid gap-2">
      {problem ? <p className="text-sm text-destructive" role="status">Reconnecting: {problem}</p> : null}
      <div ref={host} className="h-[60vh] min-h-72 w-full overflow-hidden rounded-md bg-[#0b0d10] p-2" aria-label="Terminal" />
    </div>
  );
}
