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
import { spawn, type ChildProcess } from "node:child_process";

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

export interface LocalAgentProcessRunnerOptions {
  /** Default grace period before a stop escalates to SIGKILL. */
  readonly graceMs?: number;
}

export function createLocalAgentProcessRunner(
  options: LocalAgentProcessRunnerOptions = {},
): ZelavisAgentProcessRunner {
  const defaultGraceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const started = new Set<ZelavisAgentProcess>();

  return {
    name: "local-process",

    async start(command: ZelavisAgentProcessCommand, startOptions: ZelavisAgentProcessStartOptions = {}) {
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
