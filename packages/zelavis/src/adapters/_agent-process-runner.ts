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

/** Largest partial line held while waiting for its terminator. */
export const MAX_AGENT_PROCESS_LINE_BYTES = 64 * 1024;

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
 * Splits a stream into complete lines, dropping one that never ends.
 *
 * A child that writes megabytes without a newline would otherwise grow this
 * buffer without bound. Readiness events are small, so a partial line past the
 * cap is not one and is discarded rather than held.
 */
function lineReader(
  emit: (line: string) => void,
  onOverflow: () => void,
): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    if (buffer.length > MAX_AGENT_PROCESS_LINE_BYTES) {
      buffer = "";
      onOverflow();
    }
    for (const line of lines) emit(line);
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
        lineReader(
          (line) => startOptions.onOutput?.({ stream, line }),
          () =>
            startOptions.onOutput?.({
              stream,
              line: `Discarded an over-long ${stream} line (> ${MAX_AGENT_PROCESS_LINE_BYTES} bytes).`,
            }),
        );

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
