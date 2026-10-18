import "@xterm/xterm/css/xterm.css";
import { Effect, Fiber } from "effect";
import { ApiError, object, request } from "./api.ts";

const POLL_IDLE_MS = 150;
const POLL_RETRY_MS = 1000;
const FLUSH_MS = 25;
/** The server bounds input per request; a larger paste is sent in pieces, in order. */
const INPUT_PIECE = 8 * 1024;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

/**
 * One terminal session in the page: xterm.js draws it and the Platform's terminal routes carry it.
 *
 * Output is read by polling a cursor, input is batched for a few milliseconds and sent in order by one fiber, and a lost
 * place (a reload, a rotated output file) arrives as a screen to redraw. The session lives in tmux on the server, so
 * leaving the page closes nothing; everything started here belongs to the returned cleanup.
 */
export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const api = String(props.apiBase);
  const id = encodeURIComponent(String(props.sessionId));
  const base = `${api}/runtime/terminal/sessions/${id}`;
  host.classList.add("terminal-host");
  // An island is an inline element until told otherwise: inline, it takes the width of its content, which is
  // what pressed the terminal's text against the left edge.
  host.style.display = "block";

  const program = Effect.gen(function*() {
    const [{ Terminal }, { FitAddon }] = yield* Effect.tryPromise({ try: () => Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]), catch: cause => new ApiError({ message: String(cause) }) });
    const terminal = yield* Effect.acquireRelease(Effect.sync(() => new Terminal({
      cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, scrollback: 5000,
      theme: { background: "#0b0d10", foreground: "#e6e6e6" },
    })), instance => Effect.sync(() => instance.dispose()));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminal.focus();

    let pending = "";
    const typed = yield* Effect.acquireRelease(Effect.sync(() => terminal.onData(data => { pending += data; })), subscription => Effect.sync(() => subscription.dispose()));
    void typed;
    let ended = false;
    const end = (reason: string) => { if (!ended) { ended = true; terminal.write(`\r\n\x1b[2m${reason}\x1b[0m\r\n`); } };

    // Input: one fiber sends what accumulated, in order, so keystrokes never overtake each other.
    yield* Effect.forkScoped(Effect.forever(Effect.gen(function*() {
      yield* Effect.sleep(FLUSH_MS);
      while (pending && !ended) {
        const piece = pending.slice(0, INPUT_PIECE);
        pending = pending.slice(piece.length);
        yield* request(`${base}/input`, "POST", { data: piece }).pipe(Effect.catch(error => Effect.sync(() => end(error.status === 404 ? "This terminal session has ended." : error.message))));
      }
    })));

    // Size: the terminal fits its container, and the server learns the size whenever it changes.
    let lastSize = "";
    const resize = Effect.gen(function*() {
      yield* Effect.sync(() => fit.fit()).pipe(Effect.catch(() => Effect.void));
      const size = `${terminal.cols}x${terminal.rows}`;
      if (size === lastSize || ended) return;
      lastSize = size;
      yield* request(`${base}/resize`, "POST", { cols: terminal.cols, rows: terminal.rows }).pipe(Effect.catch(error => Effect.logDebug("Terminal resize refused", error)));
    });
    const observer = yield* Effect.acquireRelease(Effect.sync(() => { const instance = new ResizeObserver(() => { Effect.runFork(resize); }); instance.observe(host); return instance; }), instance => Effect.sync(() => instance.disconnect()));
    void observer;
    yield* resize;

    // Output: read until the session ends. A transient failure is retried; "not found" means the shell exited.
    let cursor: string | undefined;
    while (!ended) {
      const outcome = yield* request(`${base}/output${cursor === undefined ? "" : `?after=${encodeURIComponent(cursor)}`}`).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        if (outcome.failure.status === 404) { end("This terminal session has ended."); break; }
        yield* Effect.sleep(POLL_RETRY_MS);
        continue;
      }
      const output = object(outcome.success);
      if (typeof output.cursor === "string") cursor = output.cursor;
      if (output.reset === true) terminal.reset();
      if (typeof output.data === "string" && output.data) terminal.write(bytesOf(output.data));
      if (output.more !== true) yield* Effect.sleep(POLL_IDLE_MS);
    }
    yield* Effect.never;
  }).pipe(Effect.scoped, Effect.catch(error => Effect.sync(() => { host.replaceChildren(Object.assign(document.createElement("p"), { className: "notice error", textContent: error.message })); })));

  const fiber = Effect.runFork(program);
  return () => { Effect.runFork(Fiber.interrupt(fiber)); host.replaceChildren(); };
}
