import { Effect } from "effect";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isFiniteNumber, isString, objectFields, parseJson } from "../core/json-validation.js";
import { IntegrationFailure, present as presentEffect, presentOperations, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import {
  checkTerminalSize,
  isTerminalSessionId,
  TERMINAL_IDLE_MS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_OUTPUT_BYTES,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_MAX_SESSIONS_PER_OWNER,
  ZelavisTerminalRefusal,
  type ZelavisTerminalControl,
  type ZelavisTerminalOutput,
  type ZelavisTerminalSession,
  type ZelavisTerminalSize,
  type ZelavisTerminalStatus,
} from "../terminal.js";

/** Output is appended to a file by tmux; past this size the stream moves to a fresh file. */
const ROTATE_BYTES = 2 * 1024 * 1024;
/** What a first read replays: the screen and this many lines of history. */
const HISTORY_LINES = 1000;
const TMUX_TIMEOUT_MS = 5000;
const REAP_INTERVAL_MS = 60_000;

export interface TmuxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs tmux against the Platform's own server socket. Injected for tests. */
export type TmuxRun = (args: readonly string[]) => Effect.Effect<TmuxResult, IntegrationFailure>;

export interface NodeTerminalControlOptions {
  /** The Platform's data directory; sessions live in `<data>/terminal`. */
  readonly dataDirectory: string;
  readonly run?: TmuxRun;
  readonly now?: () => number;
  /** `false` disables the idle reaper (tests). */
  readonly schedule?: boolean;
  readonly idleMs?: number;
  /** How often idle sessions are looked for; tests shorten it. */
  readonly reapIntervalMs?: number;
}

interface StoredSession {
  readonly id: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly cols: number;
  readonly rows: number;
  /** Which output file the stream is writing to now. */
  readonly generation: number;
}

const readStored = (text: string): StoredSession => parseJson(text, objectFields<StoredSession>({
  id: isString, owner: isString, createdAt: isString, cols: isFiniteNumber, rows: isFiniteNumber, generation: isFiniteNumber,
}));

/** The shell gets a small, fixed environment: nothing the Platform holds in its own is handed to it. */
function shellEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? home,
    ...(process.env.USER ? { USER: process.env.USER, LOGNAME: process.env.USER } : {}),
    SHELL: process.env.SHELL ?? "/bin/sh",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
  };
}

const refuse = (code: ConstructorParameters<typeof ZelavisTerminalRefusal>[0], message: string) =>
  new IntegrationFailure(new ZelavisTerminalRefusal(code, message));

const file = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (error) => new IntegrationFailure(error) });

export function createNodeTerminalControl(options: NodeTerminalControlOptions): ZelavisTerminalControl {
  const directory = join(options.dataDirectory, "terminal");
  const socket = join(directory, "tmux.sock");
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? TERMINAL_IDLE_MS;
  const environment = shellEnvironment(options.dataDirectory);
  const activity = new Map<string, number>();

  const defaultRun: TmuxRun = (args) => Effect.callback<TmuxResult, IntegrationFailure>((resume) => {
    const child = execFile("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
      env: environment, timeout: TMUX_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") resume(Effect.fail(new IntegrationFailure(error)));
      else resume(Effect.succeed({ code: error ? (error.code as number) : 0, stdout, stderr }));
    });
    return Effect.sync(() => { child.kill(); });
  });
  const tmux = options.run ?? defaultRun;
  const must = Effect.fn("Terminal.tmux")(function* (args: readonly string[]) {
    const result = yield* tmux(args);
    if (result.code !== 0) return yield* new IntegrationFailure(new Error(`tmux ${args[0]} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`));
    return result;
  });

  const sidecar = (id: string) => join(directory, `${id}.json`);
  const outputFile = (id: string, generation: number) => join(directory, `${id}.${generation}.out`);
  const name = (id: string) => `zt-${id}`;

  const ready = Effect.fn("Terminal.ready")(function* () {
    yield* file(() => mkdir(directory, { recursive: true, mode: 0o700 }));
    yield* file(() => chmod(directory, 0o700));
  });

  const status = Effect.fn("Terminal.status")(function* (): Effect.fn.Return<ZelavisTerminalStatus, TaggedFailure> {
    const probe = yield* Effect.result(tmux(["-V"]));
    if (probe._tag === "Failure") {
      const code = (probe.failure.cause as { code?: unknown } | undefined)?.code;
      return { available: false, maxSessions: TERMINAL_MAX_SESSIONS,
        reason: code === "ENOENT" ? "tmux is not installed on this server, and the terminal runs inside it." : "tmux could not be started on this server." };
    }
    return probe.success.code === 0
      ? { available: true, maxSessions: TERMINAL_MAX_SESSIONS }
      : { available: false, maxSessions: TERMINAL_MAX_SESSIONS, reason: "tmux could not be started on this server." };
  });

  const requireAvailable = Effect.fn("Terminal.requireAvailable")(function* () {
    const current = yield* status();
    if (!current.available) return yield* refuse("unavailable", current.reason ?? "The terminal is not available.");
  });

  /** Every stored session whose tmux session still exists; the others are cleaned up. */
  const stored = Effect.fn("Terminal.stored")(function* (): Effect.fn.Return<readonly StoredSession[], TaggedFailure> {
    const names = yield* file(() => readdir(directory)).pipe(Effect.catch(() => Effect.succeed([] as string[])));
    const live = yield* Effect.result(tmux(["list-sessions", "-F", "#{session_name}"]));
    const running = live._tag === "Success" && live.success.code === 0 ? new Set(live.success.stdout.split("\n")) : new Set<string>();
    const sessions: StoredSession[] = [];
    for (const entry of names.filter((candidate) => /^[0-9a-f]{16}\.json$/.test(candidate))) {
      const id = entry.slice(0, 16);
      const parsed = yield* file(() => readFile(sidecar(id), "utf8")).pipe(Effect.map(readStored), Effect.result);
      if (parsed._tag === "Failure" || !running.has(name(id))) { yield* discard(id); continue; }
      sessions.push(parsed.success);
    }
    return sessions;
  });

  const discard = Effect.fn("Terminal.discard")(function* (id: string) {
    yield* Effect.result(tmux(["kill-session", "-t", name(id)]));
    const names = yield* file(() => readdir(directory)).pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const entry of names.filter((candidate) => candidate === `${id}.json` || candidate.startsWith(`${id}.`))) {
      yield* file(() => rm(join(directory, entry), { force: true })).pipe(Effect.catch(() => Effect.void));
    }
    activity.delete(id);
  });

  const present = (session: StoredSession): ZelavisTerminalSession => ({
    id: session.id, createdAt: session.createdAt,
    lastActiveAt: new Date(activity.get(session.id) ?? now()).toISOString(), cols: session.cols, rows: session.rows,
  });

  const load = Effect.fn("Terminal.load")(function* (owner: string, id: string) {
    if (!isTerminalSessionId(id)) return yield* refuse("not-found", "No such terminal session.");
    const parsed = yield* file(() => readFile(sidecar(id), "utf8")).pipe(Effect.map(readStored), Effect.result);
    // Someone else's session is indistinguishable from a missing one.
    if (parsed._tag === "Failure" || parsed.success.owner !== owner) return yield* refuse("not-found", "No such terminal session.");
    return parsed.success;
  });

  const save = Effect.fn("Terminal.save")(function* (session: StoredSession) {
    const target = sidecar(session.id);
    yield* file(() => writeFile(`${target}.tmp`, JSON.stringify(session), { mode: 0o600 }));
    yield* file(() => rename(`${target}.tmp`, target));
  });

  const startPipe = Effect.fn("Terminal.startPipe")(function* (id: string, generation: number) {
    const target = outputFile(id, generation);
    yield* file(() => writeFile(target, "", { mode: 0o600, flag: "a" }));
    // The data directory is the Platform's own, but it is placed inside a shell command, so refuse quotes.
    if (target.includes("'")) return yield* new IntegrationFailure(new Error("The data directory path may not contain a quote."));
    yield* must(["pipe-pane", "-O", "-t", name(id), `cat >> '${target}'`]);
  });

  const list = Effect.fn("Terminal.list")(function* (owner: string): Effect.fn.Return<readonly ZelavisTerminalSession[], TaggedFailure> {
    yield* ready();
    return (yield* stored()).filter((session) => session.owner === owner).map(present)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });

  const open = Effect.fn("Terminal.open")(function* (owner: string, requested: ZelavisTerminalSize): Effect.fn.Return<ZelavisTerminalSession, TaggedFailure> {
    const size = yield* Effect.try({ try: () => checkTerminalSize(requested), catch: (error) => new IntegrationFailure(error) });
    yield* requireAvailable();
    yield* ready();
    const sessions = yield* stored();
    if (sessions.length >= TERMINAL_MAX_SESSIONS) return yield* refuse("limit", `This server allows ${TERMINAL_MAX_SESSIONS} terminal sessions at once; close one first.`);
    if (sessions.filter((session) => session.owner === owner).length >= TERMINAL_MAX_SESSIONS_PER_OWNER) {
      return yield* refuse("limit", `You can keep ${TERMINAL_MAX_SESSIONS_PER_OWNER} terminal sessions open; close one first.`);
    }
    const id = randomBytes(8).toString("hex");
    const session: StoredSession = { id, owner, createdAt: new Date(now()).toISOString(), cols: size.cols, rows: size.rows, generation: 0 };
    const created = yield* Effect.result(Effect.gen(function* () {
      yield* must(["new-session", "-d", "-s", name(id), "-x", String(size.cols), "-y", String(size.rows), "-c", homedir()]);
      yield* startPipe(id, 0);
      yield* save(session);
    }));
    if (created._tag === "Failure") { yield* discard(id); return yield* created.failure; }
    activity.set(id, now());
    return present(session);
  });

  const write = Effect.fn("Terminal.write")(function* (owner: string, id: string, data: string): Effect.fn.Return<void, TaggedFailure> {
    if (typeof data !== "string" || data.length === 0) return yield* refuse("invalid", "Input must be a non-empty string.");
    if (Buffer.byteLength(data) > TERMINAL_MAX_INPUT_BYTES) return yield* refuse("invalid", `Input is limited to ${TERMINAL_MAX_INPUT_BYTES} bytes per call.`);
    if (data.includes("\0")) return yield* refuse("invalid", "Input may not contain a NUL character.");
    yield* load(owner, id);
    activity.set(id, now());
    const result = yield* tmux(["send-keys", "-t", name(id), "-l", "--", data]);
    if (result.code !== 0) return yield* refuse("not-found", "This terminal session has ended.");
  });

  const readOutput = Effect.fn("Terminal.read")(function* (owner: string, id: string, after?: string): Effect.fn.Return<ZelavisTerminalOutput, TaggedFailure> {
    let session = yield* load(owner, id);
    activity.set(id, now());
    const match = after === undefined ? null : /^g(\d{1,9})\.(\d{1,15})$/.exec(after);
    if (after !== undefined && !match) return yield* refuse("invalid", "after is not a cursor this terminal returned.");

    let size = (yield* file(() => stat(outputFile(id, session.generation)))).size;
    if (size > ROTATE_BYTES) {
      // Start a fresh file; readers of the old one are resynchronised from the screen.
      const next = session.generation + 1;
      yield* tmux(["pipe-pane", "-t", name(id)]);
      yield* startPipe(id, next);
      const old = outputFile(id, session.generation);
      session = { ...session, generation: next };
      yield* save(session);
      yield* file(() => rm(old, { force: true }));
      size = 0;
    }

    const current = match !== null && Number(match[1]) === session.generation && Number(match[2]) <= size;
    if (!current) {
      const screen = yield* tmux(["capture-pane", "-p", "-e", "-J", "-t", name(id), "-S", `-${HISTORY_LINES}`]);
      if (screen.code !== 0) return yield* refuse("not-found", "This terminal session has ended.");
      const where = yield* tmux(["display-message", "-p", "-t", name(id), "#{cursor_x} #{cursor_y}"]);
      const [x, y] = where.stdout.trim().split(" ").map(Number);
      const text = screen.stdout.replace(/\n$/, "").split("\n").join("\r\n");
      const place = Number.isInteger(x) && Number.isInteger(y) ? `\x1b[${y! + 1};${x! + 1}H` : "";
      return { data: Buffer.from(`${text}${place}`).toString("base64"), cursor: `g${session.generation}.${size}`, reset: true, more: false };
    }

    const offset = Number(match![2]);
    const wanted = Math.min(size - offset, TERMINAL_MAX_OUTPUT_BYTES);
    if (wanted <= 0) {
      const alive = yield* tmux(["has-session", "-t", name(id)]);
      if (alive.code !== 0) return yield* refuse("not-found", "This terminal session has ended.");
      return { data: "", cursor: `g${session.generation}.${offset}`, reset: false, more: false };
    }
    const chunk = yield* Effect.acquireUseRelease(
      file(() => openFile(outputFile(id, session.generation), "r")),
      (handle) => file(() => handle.read(Buffer.alloc(wanted), 0, wanted, offset)).pipe(Effect.map(({ buffer, bytesRead }) => buffer.subarray(0, bytesRead))),
      (handle) => file(() => handle.close()).pipe(Effect.catch(() => Effect.void)),
    );
    return { data: chunk.toString("base64"), cursor: `g${session.generation}.${offset + chunk.length}`, reset: false, more: offset + chunk.length < size };
  });

  const resize = Effect.fn("Terminal.resize")(function* (owner: string, id: string, requested: ZelavisTerminalSize): Effect.fn.Return<void, TaggedFailure> {
    const size = yield* Effect.try({ try: () => checkTerminalSize(requested), catch: (error) => new IntegrationFailure(error) });
    const session = yield* load(owner, id);
    activity.set(id, now());
    const result = yield* tmux(["resize-window", "-t", name(id), "-x", String(size.cols), "-y", String(size.rows)]);
    if (result.code !== 0) return yield* refuse("not-found", "This terminal session has ended.");
    yield* save({ ...session, cols: size.cols, rows: size.rows });
  });

  const close = Effect.fn("Terminal.close")(function* (owner: string, id: string): Effect.fn.Return<void, TaggedFailure> {
    yield* load(owner, id);
    yield* discard(id);
  });

  const reap = Effect.fn("Terminal.reap")(function* () {
    const sessions = yield* stored();
    for (const session of sessions) {
      if (!activity.has(session.id)) activity.set(session.id, now());
      if (now() - activity.get(session.id)! > idleMs) yield* discard(session.id);
    }
  });
  // A session found after a restart starts its idle clock now, so a restart never closes one at once.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.schedule !== false) {
    timer = setInterval(() => { void presentEffect(Effect.result(reap())); }, options.reapIntervalMs ?? REAP_INTERVAL_MS);
    timer.unref();
  }

  const operations = presentOperations({ status, list, open, write, read: readOutput, resize, close });
  return {
    ...operations,
    stop: () => { if (timer) clearInterval(timer); },
  } as unknown as ZelavisTerminalControl;
}
