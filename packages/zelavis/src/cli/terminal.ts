import { Effect } from "effect";
import { integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis terminal <status|list|install|open|attach|close> [session-id] [--url URL] [--token TOKEN] [--json]\n  open starts a session and attaches to it; attach picks one up again; press Ctrl-] to detach and leave it running.";

const DETACH = "\u001d";
const POLL_MS = 150;

/**
 * `zelavis terminal` reaches the owner's terminal through the JS SDK client. `attach` puts this
 * terminal in raw mode and relays keystrokes and output until Ctrl-] (the session keeps running in
 * tmux on the server) or until the remote shell exits.
 */
const runTerminalCommandProgram = Effect.fn("TerminalCLI.run")(function* (args: readonly string[]): Effect.fn.Return<void, TaggedFailure> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token"].includes(flag)) return yield* new IntegrationFailure(new Error(`Unknown terminal option "${arg}". ${usage}`));
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) return yield* new IntegrationFailure(new Error(`${flag} requires a value.`));
    if (flag === "--url") url = value; else token = value;
  }
  const [action, id, ...rest] = positional;
  if (!action) { console.log(usage); return; }
  if (rest.length > 0) return yield* new IntegrationFailure(new Error(`Unexpected argument "${rest[0]}". ${usage}`));
  const base = new URL(url);
  const client = createZelavisClient({ baseUrl: base.origin, rootPath: base.pathname, headers: token ? { authorization: `Bearer ${token}` } : undefined });
  const print = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());

  switch (action) {
    case "status":
    case "list": {
      const overview = yield* integration(() => client.terminal.status());
      print(overview, () => [
        overview.available ? "A terminal is available." : `No terminal: ${overview.reason ?? "unavailable"}`,
        ...overview.sessions.map((session) => `${session.id}  ${session.cols}x${session.rows}  opened ${session.createdAt}`),
      ].join("\n"));
      return;
    }
    case "install": {
      yield* integration(() => client.terminal.install());
      print({ installed: true }, () => "tmux is installed; the terminal is available.");
      return;
    }
    case "close": {
      if (!id) return yield* new IntegrationFailure(new Error(`close needs a session id. ${usage}`));
      yield* integration(() => client.terminal.close(id));
      print({ closed: id }, () => `Closed ${id}.`);
      return;
    }
    case "open":
    case "attach": {
      if (json) return yield* new IntegrationFailure(new Error("attach is interactive and has no --json form."));
      if (!process.stdin.isTTY || !process.stdout.isTTY) return yield* new IntegrationFailure(new Error("attach needs an interactive terminal."));
      const size = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
      let sessionId: string;
      if (action === "open") sessionId = (yield* integration(() => client.terminal.open(size))).id;
      else if (id) sessionId = id;
      else return yield* new IntegrationFailure(new Error(`attach needs a session id; list them with: zelavis terminal list`));
      yield* integration(() => client.terminal.resize(sessionId, size));
      yield* attach(client, sessionId);
      return;
    }
    default:
      return yield* new IntegrationFailure(new Error(`Unknown terminal command "${action}". ${usage}`));
  }
});

const attach = Effect.fn("TerminalCLI.attach")(function* (client: ReturnType<typeof createZelavisClient>, sessionId: string): Effect.fn.Return<void, TaggedFailure> {
  let detached = false;
  let ended: Error | undefined;
  const pending: string[] = [];
  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (text.includes(DETACH)) { detached = true; return; }
    pending.push(text);
  };
  const resize = () => { void Effect.runPromise(Effect.result(integration(() => client.terminal.resize(sessionId, { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 })))); };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", resize);
  yield* Effect.gen(function* () {
    let cursor: string | undefined;
    while (!detached && !ended) {
      const typed = pending.splice(0).join("");
      if (typed) {
        const sent = yield* Effect.result(integration(() => client.terminal.write(sessionId, typed)));
        if (sent._tag === "Failure") { ended = sent.failure; break; }
      }
      const output = yield* Effect.result(integration(() => client.terminal.read(sessionId, cursor)));
      if (output._tag === "Failure") { ended = output.failure; break; }
      cursor = output.success.cursor;
      if (output.success.reset) process.stdout.write("\u001b[2J\u001b[H");
      if (output.success.data) process.stdout.write(Buffer.from(output.success.data, "base64"));
      if (!output.success.more) yield* Effect.sleep(POLL_MS);
    }
  }).pipe(Effect.ensuring(Effect.sync(() => {
    process.stdin.off("data", onData);
    process.stdout.off("resize", resize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  })));
  console.log(detached ? `\r\nDetached; the session keeps running: zelavis terminal attach ${sessionId}` : `\r\n${ended?.message ?? "The session ended."}`);
});

export function runTerminalCommand(args: readonly string[]): Promise<void> { return present(runTerminalCommandProgram(args)); }
