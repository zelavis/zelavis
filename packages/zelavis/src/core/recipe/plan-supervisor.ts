import { Effect } from "effect";
import type {
  ZelavisAgentProcess, ZelavisAgentProcessExit, ZelavisAgentProcessOutput, ZelavisAgentProcessRunner,
} from "../agent/process-command.js";
import { integration } from "../runtime/effect-boundary.js";
import { RecipeError, type ProcessPlan, type RecipeSecret } from "./recipe.js";

/**
 * Runs a validated `ProcessPlan`: the processes a recipe's `start` phase asked for.
 *
 * The recipe only describes; this starts. It does so through the Agent's process contract, the
 * same one every runtime driver uses, so a plan runs wherever an Agent does. Processes start in
 * dependency order, and one that depends on another starts only after the other's port accepts
 * connections. Independent processes start together, a few at a time. Stopping goes the other
 * way: dependents first.
 *
 * Authority. Executables come from a table the host built from the recipe's declared
 * requirements and ports from the allocation made for this Project, never from the plan's
 * text. The environment a process sees is exactly what the plan names (the host's is never
 * merged in), and secret references are resolved here, at the last moment, and never appear in
 * an error or a log line this module produces.
 *
 * Failure. A process that does not become ready, or exits first, fails the whole start, and
 * everything already started is stopped before the failure is reported. A process that exits
 * later is reported to `onExit`; the supervisor does not restart it, because whether to restart
 * is the driver's decision. Interruption stops what was started.
 */

const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_GRACE_MS = 10_000;
const START_CONCURRENCY = 4;
const MAX_LOG_LINES = 500;

export interface PlanSupervisorOptions {
  readonly runner: ZelavisAgentProcessRunner;
  /** What the Agent calls this workload; a Project id. */
  readonly workloadId: string;
  readonly cwd: string;
  /** Requirement name to absolute executable. */
  readonly commands: Readonly<Record<string, string>>;
  /** Port name to the number allocated for this Project. */
  readonly ports: Readonly<Record<string, number>>;
  readonly resolveSecret: (name: string) => Effect.Effect<string, RecipeError>;
  /** Whether something accepts connections on this loopback port right now. */
  readonly probe: (port: number) => Effect.Effect<boolean>;
  readonly pollMs?: number;
  readonly stopGraceMs?: number;
  /** A process that exited after the plan was ready, and was not asked to. */
  readonly onExit?: (name: string, exit: ZelavisAgentProcessExit) => void;
}

export interface RunningPlan {
  readonly names: readonly string[];
  /** The most recent output lines of all processes, oldest first. */
  readonly logs: () => readonly { readonly process: string; readonly stream: "stdout" | "stderr"; readonly line: string }[];
  /** Whether every process is still running. */
  readonly running: () => boolean;
  /** Stops dependents before what they depend on. Safe to call again. */
  readonly stop: Effect.Effect<void, RecipeError>;
}

const fail = (message: string) => new RecipeError({ operation: "start", message });

/** Dependency levels: everything in a level depends only on earlier levels. */
function levelsOf(plan: ProcessPlan): readonly (readonly ProcessPlan["processes"][number][])[] {
  const placed = new Set<string>();
  const levels: ProcessPlan["processes"][number][][] = [];
  let remaining = [...plan.processes];
  while (remaining.length > 0) {
    const ready = remaining.filter((process) => process.dependsOn.every((dependency) => placed.has(dependency)));
    // parseProcessPlan rejects cycles and unknown names, so a level is never empty.
    if (ready.length === 0) throw new Error("A process plan with a cycle reached the supervisor.");
    levels.push(ready);
    for (const process of ready) placed.add(process.name);
    remaining = remaining.filter((process) => !placed.has(process.name));
  }
  return levels;
}

export const startProcessPlan = (plan: ProcessPlan, options: PlanSupervisorOptions): Effect.Effect<RunningPlan, RecipeError> =>
  Effect.gen(function* () {
    const poll = options.pollMs ?? DEFAULT_POLL_MS;
    const grace = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const levels = yield* Effect.try({ try: () => levelsOf(plan), catch: () => fail("The process plan cannot be ordered.") });
    const started = new Map<string, ZelavisAgentProcess>();
    const exits = new Map<string, ZelavisAgentProcessExit>();
    const log: { process: string; stream: "stdout" | "stderr"; line: string }[] = [];
    let ready = false;

    const reveal = (value: string | RecipeSecret) => typeof value === "string" ? Effect.succeed(value) : options.resolveSecret(value.secret);

    const stopOne = (name: string) => {
      const child = started.get(name);
      return child === undefined || !child.running
        ? Effect.void
        : integration(() => child.stop({ graceMs: grace })).pipe(
            Effect.asVoid,
            Effect.mapError(() => fail(`"${name}" could not be stopped.`)),
          );
    };

    /** Dependents first: the reverse of start order, a level at a time. */
    const stopAll: Effect.Effect<void, RecipeError> = Effect.gen(function* () {
      for (const level of [...levels].reverse()) {
        yield* Effect.forEach(level, (process) => stopOne(process.name), { concurrency: START_CONCURRENCY, discard: true });
      }
    });

    const startOne = (process: ProcessPlan["processes"][number]) =>
      Effect.gen(function* () {
        const executable = options.commands[process.command];
        if (executable === undefined) return yield* Effect.fail(fail(`"${process.name}" uses "${process.command}", which this host did not provide.`));
        const port = options.ports[process.readiness.port];
        if (port === undefined) return yield* Effect.fail(fail(`"${process.name}" waits on port "${process.readiness.port}", which has no allocation.`));
        const args = yield* Effect.forEach(process.args, reveal);
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) env[name] = yield* reveal(value);

        const child = yield* integration(() => options.runner.start({
          workloadId: options.workloadId, executable, args, cwd: options.cwd, env,
        }, {
          onOutput: (output: ZelavisAgentProcessOutput) => {
            log.push({ process: process.name, stream: output.stream, line: output.line });
            if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
          },
          onExit: (exit) => {
            exits.set(process.name, exit);
            if (ready && !exit.requested) options.onExit?.(process.name, exit);
          },
        })).pipe(Effect.mapError(() => fail(`"${process.name}" could not be started.`)));
        started.set(process.name, child);

        // Ready means the port accepts connections; a process that exits first has failed.
        const deadline = Date.now() + process.readiness.timeoutMs;
        for (;;) {
          const exit = exits.get(process.name);
          if (exit !== undefined) {
            return yield* Effect.fail(fail(`"${process.name}" exited before it was ready (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}).`));
          }
          if (yield* options.probe(port)) return;
          if (Date.now() >= deadline) {
            return yield* Effect.fail(fail(`"${process.name}" was not ready on port "${process.readiness.port}" within ${process.readiness.timeoutMs} ms.`));
          }
          yield* Effect.sleep(poll);
        }
      });

    // Whatever started is stopped if a later process fails or the start is interrupted.
    yield* Effect.gen(function* () {
      for (const level of levels) {
        yield* Effect.forEach(level, startOne, { concurrency: START_CONCURRENCY, discard: true });
      }
    }).pipe(Effect.onError(() => stopAll.pipe(Effect.orElseSucceed(() => undefined))));

    ready = true;
    const plan_: RunningPlan = {
      names: plan.processes.map((process) => process.name),
      logs: () => [...log],
      running: () => [...started.values()].every((child) => child.running),
      stop: stopAll,
    };
    return plan_;
  });
