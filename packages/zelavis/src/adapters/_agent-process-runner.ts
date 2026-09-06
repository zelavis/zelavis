/**
 * The local Agent process runner.
 *
 * This is the one place a Project child process is started on this host. The
 * drivers above it — Node Project, server frontend, native WordPress — issue
 * commands through the Agent contract instead of each calling `spawn`, which
 * is what makes a remote Agent a second implementation of one contract rather
 * than a rewrite of three supervisors.
 *
 * Unifying them also settles a difference that was not a decision. Every driver
 * escalated SIGTERM to SIGKILL, but only one registered its children for
 * cleanup when the Platform process exits — so a Platform crash left a frontend
 * or a WordPress runtime running with nothing supervising it. Here the
 * registration is a property of starting a process at all.
 *
 * Honest about what it is: `process` isolation. The child runs as the same user
 * with the same filesystem view, and the driver capability that says so
 * (`secureIsolation: false`) stays false. Namespaces, cgroups, and per-Project
 * identities are a different execution boundary, and the value of this contract
 * is that they arrive as another runner rather than as edits to three drivers.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ZelavisAgentProcess,
  ZelavisAgentProcessCommand,
  ZelavisAgentProcessExit,
  ZelavisAgentProcessRunner,
  ZelavisAgentProcessStartOptions,
} from "../core/agent/process-command.js";

/**
 * Longest line delivered to a caller.
 *
 * Measured in characters rather than bytes — it is a bound on memory held per
 * stream, not an exact byte budget, and a multi-byte character is not worth a
 * decoder to count precisely.
 */
export const MAX_AGENT_PROCESS_LINE_LENGTH = 64 * 1024;

const DEFAULT_GRACE_MS = 5_000;

const liveChildren = new Set<ChildProcess>();
let exitCleanupInstalled = false;

/**
 * Asks every child still running to stop when the Platform process exits.
 *
 * `process.once("exit")` runs synchronously and cannot await, so this is a
 * signal and nothing more — the escalation to SIGKILL that `stop` performs is
 * not available here. It is still the difference between a child that is told
 * the Platform is gone and one that is simply orphaned.
 */
function registerChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));

  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const live of liveChildren) {
      if (live.exitCode === null && live.signalCode === null) {
        live.kill("SIGTERM");
      }
    }
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Splits a stream into lines, bounding how long one may be.
 *
 * A child that writes megabytes without a newline would otherwise grow this
 * buffer without bound. The bound applies to what is delivered, not only to
 * what is held: an over-long line is emitted truncated, once, and the rest of
 * it is discarded up to its terminator.
 *
 * Delivering the head rather than dropping the line matters — a stack trace
 * past the cap is still worth its first 64KB — and treating the cap the same
 * way whether it is reached mid-line or on a completed line matters more.
 * Checking only the held remainder made the result depend on where the
 * operating system happened to break the stream into chunks, so identical
 * child output produced a truncation on one machine and a 70KB line on
 * another.
 */
function lineReader(emit: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  // True while the remainder of an already-truncated line is being skipped.
  let skippingRest = false;

  const bounded = (line: string) =>
    line.length > MAX_AGENT_PROCESS_LINE_LENGTH
      ? `${line.slice(0, MAX_AGENT_PROCESS_LINE_LENGTH)}… (truncated, line exceeded ${MAX_AGENT_PROCESS_LINE_LENGTH} characters)`
      : line;

  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");

    for (
      let terminator = buffer.indexOf("\n");
      terminator !== -1;
      terminator = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, terminator);
      buffer = buffer.slice(terminator + 1);
      if (skippingRest) {
        skippingRest = false;
        continue;
      }
      emit(bounded(line));
    }

    if (skippingRest) {
      // Still inside the discarded tail; no terminator arrived in this chunk.
      buffer = "";
      return;
    }

    if (buffer.length > MAX_AGENT_PROCESS_LINE_LENGTH) {
      emit(bounded(buffer));
      buffer = "";
      skippingRest = true;
    }
  };
}

/**
 * What is written down about a process, so a later Platform can find it again.
 *
 * The pid alone is not enough to act on. Process ids are reused, and signalling
 * a reused one means killing an unrelated program — plausibly something the
 * operator cares about far more than a stale Project. The executable is
 * recorded so a candidate can be checked against what was actually started
 * before anything is signalled.
 */
interface ProcessRecord {
  readonly workloadId: string;
  readonly pid: number;
  readonly executable: string;
  readonly startedAt: string;
  /** The Platform process that started it. */
  readonly ownerPid: number;
}

export interface LocalAgentProcessRunnerOptions {
  /** Default grace period before a stop escalates to SIGKILL. */
  readonly graceMs?: number;
  /**
   * Where to record running processes so they survive this Platform.
   *
   * Without it the runner keeps no durable trace, which is the old behaviour:
   * a Platform killed outright leaves its Project processes running, and the
   * next Platform has no way to know they exist. With it, those processes are
   * found and stopped before the same workload is started again.
   */
  readonly stateDirectory?: string;
}

/** Whether a pid is alive, without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still counts as
    // alive — and as something this Platform must not touch.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How long a process has been running, in milliseconds, or undefined.
 *
 * Undefined is deliberately not "no match": being unable to check is a reason
 * to leave a process alone, not a reason to assume it is ours.
 *
 * Elapsed time rather than the command line, and rather than an absolute start
 * timestamp. The command line looked like the obvious check and is wrong: a
 * daemon rewrites its own argv, so php-fpm reports itself as
 * `php-fpm: master process (...)` and nginx as `nginx: master process ...`,
 * neither of which contains the path that was executed. A leftover php-fpm
 * survived reclamation for exactly that reason. An absolute start time would
 * work but arrives from `ps` as a local-time string that has to be parsed back;
 * elapsed time is a number of seconds and needs no timezone at all.
 */
async function processAgeMs(pid: number): Promise<number | undefined> {
  const elapsed = await new Promise<string | undefined>((resolveElapsed) => {
    execFile("ps", ["-o", "etime=", "-p", String(pid)], (error, stdout) => {
      resolveElapsed(error ? undefined : stdout.trim() || undefined);
    });
  });
  if (!elapsed) return undefined;

  // `[[dd-]hh:]mm:ss`
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(elapsed);
  if (!match) return undefined;

  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
    Number(seconds)
  ) * 1000;
}

/**
 * How far apart a recorded start and an observed one may be and still be the
 * same process.
 *
 * The record is written immediately after the spawn returns, so the true gap is
 * milliseconds. The allowance is for a loaded host and for `ps` reporting
 * elapsed time only to the second.
 */
const START_TIME_TOLERANCE_MS = 30_000;

export function createLocalAgentProcessRunner(
  options: LocalAgentProcessRunnerOptions = {},
): ZelavisAgentProcessRunner {
  const defaultGraceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const started = new Set<ZelavisAgentProcess>();
  const stateDirectory = options.stateDirectory;
  /**
   * A full sweep, once, on the first process this runner starts.
   *
   * Reclaiming only the workload being started would leave every other
   * Project's processes running — including a Project the operator has since
   * stopped, which is never started again and so never triggers a per-workload
   * reclaim. That is the shape the leak was actually found in: daemons from a
   * Project nobody touched again, still running days later.
   */
  let sweep: Promise<number> | undefined;

  async function writeRecord(record: ProcessRecord): Promise<string | undefined> {
    if (!stateDirectory) return undefined;
    const file = join(stateDirectory, `${randomUUID()}.json`);
    try {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return file;
    } catch {
      // Recording is a recovery aid, not a precondition for running. A host
      // that cannot write here still starts Projects; it just cannot clean up
      // after a crash.
      return undefined;
    }
  }

  async function readRecords(): Promise<{ file: string; record: ProcessRecord }[]> {
    if (!stateDirectory) return [];
    const names = await readdir(stateDirectory).catch(() => [] as string[]);
    const records: { file: string; record: ProcessRecord }[] = [];

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(stateDirectory, name);
      const raw = await readFile(file, "utf8").catch(() => undefined);
      if (raw === undefined) continue;

      let record: ProcessRecord;
      try {
        record = JSON.parse(raw) as ProcessRecord;
      } catch {
        // A record torn by a crash mid-write describes nothing actionable.
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }

      if (
        typeof record.pid !== "number" ||
        typeof record.executable !== "string" ||
        typeof record.workloadId !== "string"
      ) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }

      records.push({ file, record });
    }

    return records;
  }

  /**
   * Stops processes a previous Platform left running.
   *
   * Stopped, not adopted. A child's output arrives over pipes held by the
   * process that spawned it, and those pipes died with it — there is no way to
   * reattach, so a "reclaimed" process could never report readiness, stream
   * logs, or be stopped through the contract. Terminating it and starting
   * cleanly is the only honest option, and it is the one that fixes the actual
   * damage: a stale process holding the port the new one needs, answering
   * traffic the Platform believes it is serving itself.
   */
  async function reclaim(workloadId?: string): Promise<number> {
    let reclaimed = 0;

    for (const { file, record } of await readRecords()) {
      if (workloadId !== undefined && record.workloadId !== workloadId) continue;

      // Ours, and still tracked in memory: `close` handles it.
      if (record.ownerPid === process.pid) continue;

      // Another live Platform's process. Two Platforms on one data directory is
      // already unsupported, but killing a running installation's Projects is
      // not how that should be discovered.
      if (isAlive(record.ownerPid)) continue;

      if (!isAlive(record.pid)) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }

      // The pid is alive, but is it still the process that was recorded? Ids
      // are reused, and days can pass between the crash and this check. A
      // reused pid belongs to a process that started after ours died, so the
      // ages disagree by far more than the tolerance.
      const ageMs = await processAgeMs(record.pid);
      const recordedAgeMs = Date.now() - Date.parse(record.startedAt);
      if (
        ageMs === undefined ||
        !Number.isFinite(recordedAgeMs) ||
        Math.abs(ageMs - recordedAgeMs) > START_TIME_TOLERANCE_MS
      ) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }

      try {
        process.kill(record.pid, "SIGTERM");
        const deadline = Date.now() + defaultGraceMs;
        while (isAlive(record.pid) && Date.now() < deadline) {
          await new Promise((wait) => setTimeout(wait, 100));
        }
        if (isAlive(record.pid)) process.kill(record.pid, "SIGKILL");
        reclaimed += 1;
      } catch {
        // It exited between the check and the signal, which is the outcome
        // being asked for anyway.
      }

      await rm(file, { force: true }).catch(() => undefined);
    }

    return reclaimed;
  }

  return {
    name: "local-process",
    // A child's pipes belong to this process. When it goes, they go, and
    // nothing can take the child over — which is why `attach` is absent here
    // rather than returning an empty list and implying it looked.
    survivesControlPlaneRestart: false,
    reclaim,

    async start(command: ZelavisAgentProcessCommand, startOptions: ZelavisAgentProcessStartOptions = {}) {
      // Before anything is started for this workload, stop what a previous
      // Platform left running for it. Doing this here rather than at boot means
      // no ordering discipline for callers: the reclamation happens on exactly
      // the path where a leftover does damage.
      sweep ??= reclaim();
      await sweep;
      // Cheap insurance for a record written after that sweep — another
      // Platform crashing while this one runs.
      await reclaim(command.workloadId);

      const child = spawn(command.executable, [...(command.args ?? [])], {
        cwd: command.cwd,
        env: { ...command.env },
        // No shell: arguments are values, never a command line to be parsed.
        // No inherited stdin: a Project process must never read the terminal
        // the Platform was started from.
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      registerChild(child);

      const recordFile = child.pid
        ? await writeRecord({
            workloadId: command.workloadId,
            pid: child.pid,
            executable: command.executable,
            startedAt: new Date().toISOString(),
            ownerPid: process.pid,
          })
        : undefined;

      let requested = false;
      let settled: ZelavisAgentProcessExit | undefined;

      const emit = (stream: "stdout" | "stderr") =>
        lineReader((line) => startOptions.onOutput?.({ stream, line }));

      child.stdout?.on("data", emit("stdout"));
      child.stderr?.on("data", emit("stderr"));

      const exit = new Promise<ZelavisAgentProcessExit>((resolveExit) => {
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = { code, signal, requested };
          // The record describes a process that exists. Removing it on exit is
          // what keeps a later reclamation from chasing dead pids — and, worse,
          // pids the operating system has since handed to something else.
          if (recordFile) void rm(recordFile, { force: true }).catch(() => undefined);
          startOptions.onExit?.(settled);
          resolveExit(settled);
        };

        // A spawn failure — a missing executable, most often — never produces
        // an `exit`, so a caller awaiting one would wait forever.
        child.once("error", () => finish(null, null));
        child.once("exit", (code, signal) => finish(code, signal));
      });

      const handle: ZelavisAgentProcess = {
        workloadId: command.workloadId,
        get running() {
          return !settled && !hasExited(child);
        },
        exit,
        async stop(stopOptions) {
          requested = true;
          if (settled) return settled;
          if (hasExited(child)) return exit;

          child.kill("SIGTERM");

          const graceMs = stopOptions?.graceMs ?? defaultGraceMs;
          const escalation = setTimeout(() => {
            if (!hasExited(child)) child.kill("SIGKILL");
          }, graceMs);

          try {
            return await exit;
          } finally {
            clearTimeout(escalation);
          }
        },
      };

      started.add(handle);
      void exit.then(() => started.delete(handle));
      return handle;
    },

    async close() {
      // Concurrently: closing is on the Platform's shutdown path, and stopping
      // Projects one grace period at a time turns a fleet into a timeout.
      await Promise.all([...started].map((handle) => handle.stop().catch(() => undefined)));
    },
  };
}
