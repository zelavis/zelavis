import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber, Semaphore } from "effect";
import { arrayOf, isBoolean, isPositiveInteger, isTimestamp, literal, objectFields, optional, parseJson } from "../core/json-validation.js";
import { evaluate, integration, IntegrationFailure, present, presentOperations } from "../core/runtime/effect-boundary.js";
import type { AgentPlacementIdentity } from "../core/agent/placement-lease.js";
import type { ZelavisAgentAttachedProcess, ZelavisAgentProcess, ZelavisAgentProcessCommand, ZelavisAgentProcessExit, ZelavisAgentProcessOutput, ZelavisAgentProcessRunner, ZelavisAgentProcessStartOptions } from "../core/agent/process-command.js";
import { lineReader } from "./_agent-process-runner.js";
import { writeNodeProjectControl } from "./_node-project-control.js";

const MAX_PROCESSES = 4096;
const RECORD_LIMIT = 64 * 1024;
const READ_BYTES = 64 * 1024;
export const MAX_AGENT_LOG_BYTES = 8 * 1024 * 1024;
const REPLAY_LINES = 500;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const boundedString = (value: unknown): value is string => typeof value === "string" && value.length <= 8192;
const placementRecord = objectFields<AgentPlacementIdentity>({ projectId: boundedString, nodeId: boundedString, ownerSession: boundedString, epoch: isPositiveInteger });
type Command = Pick<ZelavisAgentProcessCommand, "workloadId" | "executable" | "args" | "cwd" | "placement" | "control" | "stdin">;
interface ProcessRecord extends Command {
  readonly protocol: "zelavis-agent-process/1";
  readonly processId: string;
  readonly pid: number;
  readonly ownerPid: number;
  readonly startedAt: string;
  readonly bootId: string;
  readonly startTicks: string;
  readonly survivable: boolean;
  readonly stdout: { readonly dev: number; readonly ino: number };
  readonly stderr: { readonly dev: number; readonly ino: number };
  readonly stopping?: readonly { readonly pid: number; readonly startTicks: string }[];
}
const fileIdentity = objectFields<{ dev: number; ino: number }>({ dev: isPositiveInteger, ino: isPositiveInteger });
const recordSchema = objectFields<ProcessRecord>({
  protocol: literal("zelavis-agent-process/1"), processId: uuid, pid: isPositiveInteger, ownerPid: isPositiveInteger,
  startedAt: isTimestamp, bootId: uuid, startTicks: (value): value is string => typeof value === "string" && /^\d{1,30}$/.test(value),
  survivable: isBoolean, stdout: fileIdentity, stderr: fileIdentity,
  stopping: optional((value): value is readonly { pid: number; startTicks: string }[] => Array.isArray(value) && value.length <= 256 && arrayOf(objectFields({ pid: isPositiveInteger, startTicks: (value): value is string => typeof value === "string" && /^\d{1,30}$/.test(value) }))(value)),
  workloadId: (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128, executable: boundedString, cwd: boundedString,
    args: optional((value): value is readonly string[] => Array.isArray(value) && value.length <= 1024 && arrayOf(boundedString)(value)),
    stdin: optional(literal("pipe")), placement: optional(placementRecord),
    control: optional(objectFields({ socketPath: boundedString, credentialsFile: boundedString })),
});
interface Identity { readonly startTicks: string; readonly group: number; readonly session: number; readonly dead: boolean }
/** /proc start ticks + boot identity avoid elapsed-time tolerance and zombies. */
const identity = Effect.fn("SurvivableRunner.identity")(function* (pid: number) {
  const source = yield* integration(() => readFile(`/proc/${pid}/stat`, "utf8")).pipe(
    Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT" || (error.cause as NodeJS.ErrnoException)?.code === "ESRCH", () => Effect.succeed(undefined)),
  );
  if (source === undefined || source.length === 0) return undefined;
  return yield* evaluate((): Identity => {
    const fields = source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[2] ?? "")) throw new Error("Unverifiable kernel process identity.");
    return { startTicks: fields[19]!, group: Number(fields[2]), session: Number(fields[3]), dead: ["Z", "X"].includes(fields[0]!) };
  });
});
interface Stream {
  readonly file: FileHandle;
  offset: number;
  reader: (chunk: Buffer) => void;
  discardPrefix: boolean;
  decoder: StringDecoder;
}
interface Entry {
  record: ProcessRecord;
  readonly stopPermit: Semaphore.Semaphore;
  readonly handle: ZelavisAgentProcess;
  readonly exited: Deferred.Deferred<ZelavisAgentProcessExit>;
  readonly output: ZelavisAgentProcessOutput[];
  outputBytes: number;
  readonly streams: readonly [Stream, Stream];
  readonly child?: ChildProcess;
  listener?: (output: ZelavisAgentProcessOutput) => void;
  onExit?: ZelavisAgentProcessStartOptions["onExit"];
  monitor?: Fiber.Fiber<void, never>;
  settled?: ZelavisAgentProcessExit;
  requested: boolean;
}

/** Linux daemon mode. One kernel lock protects every recovery/publication.
 * Existing in-process/dev runners retain their ordinary pipe semantics. */
export function createSurvivableAgentProcessRunner(options: { readonly stateDirectory: string; readonly graceMs?: number }): ZelavisAgentProcessRunner {
  const directory = resolve(options.stateDirectory);
  const lifecycle = Semaphore.makeUnsafe(1);
  const entries = new Map<string, Entry>();
  let lock: DatabaseSync | undefined;
  let bootId = "";
  let initialized = false;
  let closed = false;
  const graceMs = options.graceMs ?? 5000;
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 95_000) throw new Error("Agent stop grace must be an integer from 0 through 95000 ms.");
  const recordPath = (id: string) => join(directory, `${id}.json`);
  const logPath = (id: string, stream: string) => join(directory, `${id}.${stream}`);

  const syncDirectory = () => Effect.acquireUseRelease(integration(() => open(directory, "r")), file => integration(() => file.sync()), file => integration(() => file.close()).pipe(Effect.orDie));
  const writeRecord = Effect.fn("SurvivableRunner.writeRecord")(function* (record: ProcessRecord) {
    if (Buffer.byteLength(JSON.stringify(record)) > RECORD_LIMIT) return yield* new IntegrationFailure(new Error("Agent process record exceeds its bound."));
    const temporary = `${recordPath(record.processId)}.pending`;
    yield* Effect.gen(function* () {
      yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o600)), file => Effect.gen(function* () {
        yield* integration(() => file.writeFile(`${JSON.stringify(record)}\n`));
        yield* integration(() => file.sync());
      }), file => integration(() => file.close()).pipe(Effect.orDie));
      yield* integration(() => rename(temporary, recordPath(record.processId)));
      yield* syncDirectory();
    }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
  });
  const matches = Effect.fn("SurvivableRunner.matches")(function* (record: ProcessRecord) {
    const observed = yield* identity(record.pid);
    return observed && record.bootId === bootId && observed.startTicks === record.startTicks && observed.group === record.pid ? observed : undefined;
  });
  const send = Effect.fn("SurvivableRunner.signal")(function* (entry: Entry, value: string) {
    if (entry.settled || !(yield* matches(entry.record))) return false;
    return yield* evaluate(() => {
      try { process.kill(-entry.record.pid, value as NodeJS.Signals); return true; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false; throw cause; }
    });
  });
  const tail = Effect.fn("SurvivableRunner.tail")(function* (entry: Entry) {
    for (const stream of entry.streams) {
      const stats = yield* integration(() => stream.file.stat());
      // Append writers survive in-place truncation, including path deletion.
      // Retention is a polling bound; output around truncation may be lost.
      if (stats.size > MAX_AGENT_LOG_BYTES) {
        yield* integration(() => stream.file.truncate(0));
        stream.offset = 0;
        stream.discardPrefix = false;
        stream.decoder = new StringDecoder("utf8");
        stream.reader = lineReader(line => emit(entry, stream === entry.streams[0] ? "stdout" : "stderr", line));
        continue;
      }
      if (stats.size < stream.offset) {
        stream.offset = 0;
        stream.discardPrefix = false;
        stream.decoder = new StringDecoder("utf8");
        stream.reader = lineReader(line => emit(entry, stream === entry.streams[0] ? "stdout" : "stderr", line));
      }
      const bytes = Buffer.alloc(Math.min(READ_BYTES, Math.max(0, stats.size - stream.offset)));
      if (!bytes.length) continue;
      const { bytesRead } = yield* integration(() => stream.file.read(bytes, 0, bytes.length, stream.offset));
      stream.offset += bytesRead;
      let chunk = bytes.subarray(0, bytesRead);
      if (stream.discardPrefix) {
        const newline = chunk.indexOf(10);
        if (newline === -1) continue;
        stream.discardPrefix = false;
        chunk = chunk.subarray(newline + 1);
      }
      stream.reader(Buffer.from(stream.decoder.write(chunk)));
    }
  });
  function emit(entry: Entry, stream: "stdout" | "stderr", line: string) {
    const output = { stream, line };
    entry.output.push(output);
    entry.outputBytes += Buffer.byteLength(line);
    while (entry.output.length > REPLAY_LINES || entry.outputBytes > READ_BYTES) entry.outputBytes -= Buffer.byteLength(entry.output.shift()!.line);
    entry.listener?.(output);
  }
  const finish = Effect.fn("SurvivableRunner.finish")(function* (entry: Entry, exit: ZelavisAgentProcessExit) {
    if (entry.settled) return;
    entry.settled = exit;
    // Death has been independently proved. A cleanup I/O failure must retain
    // recoverable records and report diagnostics, not leave exit unresolved.
    yield* tail(entry).pipe(Effect.catch(error => Effect.logWarning(`Final Agent log tail failed: ${error.message}`)));
    for (const stream of entry.streams) yield* integration(() => stream.file.close()).pipe(Effect.catch(error => Effect.logWarning(`Agent log close failed: ${error.message}`)));
    yield* Effect.gen(function* () {
      yield* integration(() => rm(recordPath(entry.record.processId), { force: true }));
      for (const stream of ["out", "err"]) yield* integration(() => rm(logPath(entry.record.processId, stream), { force: true }));
    }).pipe(Effect.catch(error => Effect.logWarning(`Dead Agent process cleanup will retry at recovery: ${error.message}`)));
    entries.delete(entry.record.processId);
    yield* evaluate(() => entry.onExit?.(exit)).pipe(
      Effect.catch(error => Effect.logWarning(`Agent exit listener failed: ${error.message}`)),
      Effect.ensuring(Deferred.succeed(entry.exited, exit).pipe(Effect.asVoid)),
    );
  });
  const liveMember = Effect.fn("SurvivableRunner.liveMember")(function* (record: ProcessRecord, member: { pid: number; startTicks: string }) {
    const observed = yield* identity(member.pid);
    return record.bootId === bootId && observed && !observed.dead && observed.startTicks === member.startTicks &&
      observed.group === record.pid && observed.session === record.pid;
  });
  const groupSnapshot = Effect.fn("SurvivableRunner.groupSnapshot")(function* (record: ProcessRecord) {
    // Capture exact descendant births before signalling the leader. If it exits
    // first, escalation can still target proved members without a PGID-reuse guess.
    const names = yield* integration(() => readdir("/proc"));
    if (names.length > 65_536) return yield* new IntegrationFailure(new Error("Kernel process census exceeds the Agent stop bound."));
    const members: { pid: number; startTicks: string }[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name), observed = yield* identity(pid);
      if (pid === record.pid || !observed || observed.dead || observed.group !== record.pid || observed.session !== record.pid) continue;
      if (members.length >= 256) return yield* new IntegrationFailure(new Error("Project process group exceeds the Agent stop bound."));
      members.push({ pid, startTicks: observed.startTicks });
    }
    return members;
  });
  const stopProgram = Effect.fn("SurvivableRunner.stop")(function* (entry: Entry, timeout = graceMs) {
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 95_000) return yield* new IntegrationFailure(new Error("Agent stop grace exceeds its bound."));
    if (entry.settled) return entry.settled;
    entry.requested = true;
    if (!entry.record.stopping) {
      // A matching live/zombie leader pins the group generation during census.
      const observed = yield* matches(entry.record);
      const members = observed ? yield* groupSnapshot(entry.record) : [];
      const stopping = { ...entry.record, stopping: members };
      yield* writeRecord(stopping);
      entry.record = stopping;
    }
    const members = entry.record.stopping!;
    yield* send(entry, "SIGTERM");
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const observed = yield* matches(entry.record);
      const descendants = yield* Effect.forEach(members, member => liveMember(entry.record, member), { concurrency: 8 });
      if ((!observed || observed.dead) && !descendants.some(Boolean)) break;
      yield* Effect.sleep(25);
    }
    const remaining = yield* matches(entry.record);
    if (remaining && !remaining.dead) yield* send(entry, "SIGKILL");
    // The leader may already be reaped. Each descendant signal uses its own
    // persisted birth identity rather than signalling a now-unowned group id.
    for (const member of members) if (yield* liveMember(entry.record, member)) yield* evaluate(() => {
      try { process.kill(member.pid, "SIGKILL"); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
    });
    const killedBy = Date.now() + 5000;
    while (!entry.settled) {
      const observed = yield* matches(entry.record);
      const descendants = yield* Effect.forEach(members, member => liveMember(entry.record, member), { concurrency: 8 });
      if ((!observed || observed.dead) && !descendants.some(Boolean)) {
        yield* finish(entry, { code: entry.child?.exitCode ?? null, signal: entry.child?.signalCode ?? null, requested: true });
        break;
      }
      if (Date.now() > killedBy) return yield* new IntegrationFailure(new Error("Project process group could not be proved stopped."));
      yield* Effect.sleep(25);
    }
    return yield* Deferred.await(entry.exited);
  });
  const stop = (entry: Entry, timeout?: number) => entry.stopPermit.withPermit(stopProgram(entry, timeout));
  const openLog = Effect.fn("SurvivableRunner.openLog")(function* (id: string, stream: "out" | "err", expected?: { dev: number; ino: number }) {
    const file = yield* integration(() => open(logPath(id, stream), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | (expected ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600));
    return yield* Effect.gen(function* () {
      const stats = yield* integration(() => file.stat());
      yield* evaluate(() => {
        if (!stats.isFile() || stats.uid !== process.getuid?.() || stats.nlink !== 1 || (stats.mode & 0o077) !== 0 ||
          expected && (expected.dev !== stats.dev || expected.ino !== stats.ino)) throw new Error("Agent log is not the recorded private regular file.");
      });
      return file;
    }).pipe(Effect.onError(() => integration(() => file.close()).pipe(Effect.orDie)));
  });
  const track = Effect.fn("SurvivableRunner.track")(function* (record: ProcessRecord, files: readonly [FileHandle, FileHandle], child?: ChildProcess, listeners?: ZelavisAgentProcessStartOptions) {
    const exited = Deferred.makeUnsafe<ZelavisAgentProcessExit>();
    let entry: Entry;
    const handle: ZelavisAgentProcess = {
      id: record.processId, pid: record.pid, workloadId: record.workloadId,
      get running() { return !entry.settled; }, exit: present(Deferred.await(exited)),
      stop: options => present(stop(entry, options?.graceMs)),
      signal: value => present(send(entry, value)),
      listen: listener => { entry.listener = listener; },
      write: data => present(Effect.gen(function* () {
        const observed = yield* matches(record);
        if (entry.settled || !observed || observed.dead) return false;
        if (record.control) return yield* writeNodeProjectControl(record.control, record.pid, data);
        if (!child?.stdin?.writable) return false;
        return yield* Effect.callback<boolean, IntegrationFailure>(resume => {
          child.stdin!.write(data, cause => resume(cause ? Effect.fail(new IntegrationFailure(cause)) : Effect.succeed(true)));
        });
      })),
    };
    entry = { record, stopPermit: Semaphore.makeUnsafe(1), handle, exited, output: [], outputBytes: 0, requested: record.stopping !== undefined, child,
      listener: listeners?.onOutput, onExit: listeners?.onExit,
      streams: files.map((file, index) => ({ file, offset: 0, discardPrefix: false, decoder: new StringDecoder("utf8"),
        reader: lineReader(line => emit(entry, index === 0 ? "stdout" : "stderr", line)) })) as [Stream, Stream],
    };
    // Rebuild only a bounded tail, discarding a potentially partial first line.
    if (!child) for (const stream of entry.streams) {
      const stats = yield* integration(() => stream.file.stat());
      stream.offset = Math.max(0, stats.size - READ_BYTES);
      stream.discardPrefix = stream.offset > 0;
    }
    entries.set(record.processId, entry);
    yield* tail(entry);
    entry.monitor = Effect.runFork(Effect.gen(function* () {
      let retryMs = 250, failures = 0;
      while (!entry.settled && !closed) {
        const observation = yield* Effect.result(Effect.gen(function* () {
          const observed = yield* matches(record);
          if ((!observed || observed.dead) && !entry.requested) {
            yield* finish(entry, { code: child?.exitCode ?? null, signal: child?.signalCode ?? null, requested: entry.requested });
          } else yield* tail(entry);
        }));
        if (entry.settled) return;
        if (observation._tag === "Failure") {
          if (failures++ % 30 === 0) yield* Effect.logWarning(`Agent observation failed; record retained and retrying: ${observation.failure.message}`);
          retryMs = Math.min(2000, retryMs * 2);
        } else { retryMs = 250; failures = 0; }
        yield* Effect.sleep(retryMs);
      }
    }).pipe(Effect.catchCause(cause => Effect.logError(`Agent process monitoring failed; record retained: ${String(cause)}`))));
    return entry;
  });
  const initialize = Effect.fn("SurvivableRunner.initialize")(function* () {
    if (closed) return yield* new IntegrationFailure(new Error("Agent runner is closed."));
    if (initialized) return;
    yield* evaluate(() => { if (process.platform !== "linux" || !process.execve) throw new Error("Survivable Agent execution requires Node on Linux with procfs and execve."); });
    yield* integration(() => mkdir(directory, { recursive: true, mode: 0o700 }));
    const stats = yield* integration(() => lstat(directory));
    yield* evaluate(() => { if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.()) throw new Error("Agent state must be an owned real directory."); });
    yield* integration(() => chmod(directory, 0o700));
    if (!lock) {
      const path = join(directory, ".runner-lock.sqlite");
      yield* Effect.acquireUseRelease(integration(() => open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)), () => Effect.void, file => integration(() => file.close()).pipe(Effect.orDie));
      lock = yield* evaluate(() => {
        const database = new DatabaseSync(path);
        try { database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); return database; }
        catch (cause) { database.close(); throw cause; }
      });
    }
    bootId = (yield* integration(() => readFile("/proc/sys/kernel/random/boot_id", "utf8"))).trim();
    const names = yield* integration(() => readdir(directory));
    if (names.length > MAX_PROCESSES * 4) return yield* new IntegrationFailure(new Error("Agent process record directory exceeds its bound."));
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = yield* Effect.acquireUseRelease(integration(() => open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)), file => Effect.gen(function* () {
        const stats = yield* integration(() => file.stat());
        yield* evaluate(() => { if (!stats.isFile() || stats.size > RECORD_LIMIT || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) throw new Error("Invalid Agent process record file."); });
        const bytes = Buffer.alloc(RECORD_LIMIT + 1);
        const { bytesRead } = yield* integration(() => file.read(bytes, 0, bytes.length, 0));
        return yield* evaluate(() => {
          if (bytesRead > RECORD_LIMIT) throw new Error("Agent process record exceeds its bound.");
          const record = parseJson(bytes.subarray(0, bytesRead).toString("utf8"), recordSchema);
          if (name !== `${record.processId}.json`) throw new Error("Agent process record identity differs from its filename.");
          return record;
        });
      }), file => integration(() => file.close()).pipe(Effect.orDie));
      if (entries.has(record.processId)) continue;
      const observed = yield* matches(record);
      if ((!observed || observed.dead) && !record.stopping) {
        yield* integration(() => rm(recordPath(record.processId)));
        for (const stream of ["out", "err"]) yield* integration(() => rm(logPath(record.processId, stream), { force: true }));
        continue;
      }
      const out = yield* openLog(record.processId, "out", record.stdout);
      const err = yield* openLog(record.processId, "err", record.stderr).pipe(Effect.onError(() => integration(() => out.close()).pipe(Effect.orDie)));
      const entry = yield* track(record, [out, err]);
      if (!record.survivable || record.stopping) yield* stop(entry);
    }
    // A launcher that lost its parent before activation exits on EOF. Remove
    // only unpublished UUID artifacts after every published record validated.
    for (const name of names) {
      const match = /^([a-f0-9-]{36})\.(out|err|pending)$/.exec(name);
      if (match && uuid(match[1]) && !names.includes(`${match[1]}.json`)) yield* integration(() => rm(join(directory, name), { force: true }));
    }
    initialized = true;
  });
  const attached = (entry: Entry): ZelavisAgentAttachedProcess => ({ process: entry.handle, command: { workloadId: entry.record.workloadId, executable: entry.record.executable, args: entry.record.args, cwd: entry.record.cwd, placement: entry.record.placement, control: entry.record.control }, replay: entry.output.slice() });
  const recover = () => lifecycle.withPermit(Effect.gen(function* () { yield* initialize(); return [...entries.values()].map(attached); }));
  return Object.assign(presentOperations({
    recover,
    attach: workloadId => lifecycle.withPermit(Effect.gen(function* () { yield* initialize(); return [...entries.values()].filter(entry => entry.record.workloadId === workloadId).map(attached); })),
    reclaim: () => lifecycle.withPermit(Effect.gen(function* () { yield* initialize(); return 0; })),
    fencePlacement: placement => lifecycle.withPermit(Effect.gen(function* () {
      yield* initialize();
      const selected = [...entries.values()].filter(entry => entry.record.workloadId === placement.projectId);
      for (const entry of selected) {
        const actual = entry.record.placement;
        if (!actual || actual.nodeId !== placement.nodeId || actual.ownerSession !== placement.ownerSession || actual.epoch !== placement.epoch) return false;
      }
      for (const entry of selected) yield* stop(entry);
      return true;
    })),
    start: (command, listeners = {}) => lifecycle.withPermit(Effect.gen(function* () {
      yield* initialize();
      if (entries.size >= MAX_PROCESSES) return yield* new IntegrationFailure(new Error("Agent process limit reached."));
      const { workloadId, executable, args, cwd, placement, control, stdin } = command;
      if (control && stdin) return yield* new IntegrationFailure(new Error("Private control and interactive stdin are mutually exclusive."));
      if (args?.[0]?.endsWith("/_node-project-runner.js") && !control)
        return yield* new IntegrationFailure(new Error("Persistent Project hosts require reconnectable private control. Start this Project from the current Platform engine."));
      const stored: Command = { workloadId, executable, cwd, ...(args ? { args } : {}), ...(placement ? { placement } : {}), ...(control ? { control } : {}), ...(stdin ? { stdin } : {}) };
      const id = randomUUID(), nonce = randomBytes(32).toString("base64url");
      const out = yield* openLog(id, "out");
      const err = yield* openLog(id, "err").pipe(Effect.onError(() => integration(() => out.close()).pipe(Effect.orDie)));
      let child: ChildProcess | undefined, tracked = false, spawnedStart: string | undefined;
      return yield* Effect.gen(function* () {
        child = yield* evaluate(() => spawn(process.execPath, [fileURLToPath(new URL("./_agent-process-launcher.js", import.meta.url)), nonce, executable, ...(args ?? [])],
          { cwd, env: { ...command.env }, detached: true, shell: false, stdio: ["pipe", out.fd, err.fd] }));
        yield* Effect.callback<void, IntegrationFailure>(resume => {
          child!.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
          child!.once("spawn", () => resume(Effect.void));
        });
        const observed = yield* identity(child.pid!);
        if (!observed || observed.dead || observed.group !== child.pid) return yield* new IntegrationFailure(new Error("Spawned process identity cannot be proved."));
        spawnedStart = observed.startTicks;
        const stdout = yield* integration(() => out.stat()), stderr = yield* integration(() => err.stat());
        const record: ProcessRecord = { protocol: "zelavis-agent-process/1", processId: id, pid: child.pid!, ownerPid: process.pid,
          startedAt: new Date().toISOString(), bootId, startTicks: observed.startTicks, survivable: stdin !== "pipe", ...stored,
          stdout: { dev: stdout.dev, ino: stdout.ino }, stderr: { dev: stderr.dev, ino: stderr.ino } };
        yield* evaluate(() => { if (!recordSchema(record) || Buffer.byteLength(JSON.stringify(record)) > RECORD_LIMIT) throw new Error("Process command exceeds durable record bounds."); });
        yield* writeRecord(record);
        const entry = yield* track(record, [out, err], child, listeners);
        tracked = true;
        yield* Effect.callback<void, IntegrationFailure>(resume => {
          const done = (cause?: Error | null) => resume(cause ? Effect.fail(new IntegrationFailure(cause)) : Effect.void);
          if (stdin === "pipe") child!.stdin!.write(`${nonce}\n`, done);
          else child!.stdin!.end(`${nonce}\n`, done);
        });
        return entry.handle;
      }).pipe(Effect.onError(() => Effect.gen(function* () {
        child?.stdin?.destroy();
        if (child?.pid && spawnedStart) {
          const observed = yield* identity(child.pid);
          if (observed?.startTicks === spawnedStart && observed.group === child.pid) yield* evaluate(() => {
            try { process.kill(-child!.pid!, "SIGKILL"); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
          });
        }
        if (!tracked) for (const file of [out, err]) yield* integration(() => file.close());
        // A published record is retained until the process monitor proves death.
      }).pipe(Effect.orDie)));
    })),
    detach: () => lifecycle.withPermit(Effect.gen(function* () {
      if (closed) return;
      for (const entry of [...entries.values()]) if (!entry.record.survivable) yield* stop(entry);
      closed = true;
      for (const entry of [...entries.values()]) {
        if (entry.monitor) yield* Fiber.interrupt(entry.monitor);
        for (const stream of entry.streams) yield* integration(() => stream.file.close());
        entry.child?.unref();
      }
      yield* evaluate(() => { lock?.close(); lock = undefined; });
      entries.clear();
    })),
    close: () => lifecycle.withPermit(Effect.gen(function* () {
      if (closed) return;
      yield* Effect.forEach([...entries.values()], entry => stop(entry), { concurrency: 8, discard: true });
      closed = true;
      yield* evaluate(() => { lock?.close(); lock = undefined; });
    })),
  }), { name: "survivable-process", survivesControlPlaneRestart: true });
}
