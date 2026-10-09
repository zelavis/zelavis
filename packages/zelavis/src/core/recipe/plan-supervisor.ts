import { Effect } from "effect";
import type {
  ZelavisAgentAttachedProcess, ZelavisAgentProcess, ZelavisAgentProcessExit, ZelavisAgentProcessOutput, ZelavisAgentProcessRunner,
} from "../agent/process-command.js";
import type { AgentPlacementIdentity } from "../agent/placement-lease.js";
import { integration } from "../runtime/effect-boundary.js";
import { RecipeError, type ProcessPlan, type RecipeSecret } from "./recipe.js";

/**
 * Runs a validated `ProcessPlan`: the processes a recipe's `start` phase asked for.
 *
 * The recipe only describes; this starts. It does so through the Agent's process contract, the
 * same one every runtime driver uses, so a plan runs wherever an Agent does. Processes start in
 * dependency order, and one that depends on another starts only after the other is ready (its
 * port accepts connections, or its file exists). Independent processes start together, a few at
 * a time. Stopping goes the other way: dependents first.
 *
 * Authority. Executables come from a table the host built from the recipe's declared
 * requirements and ports from the allocation made for this Project, never from the plan's
 * text. The environment a process sees is the host's base environment plus exactly what the
 * plan names (the Platform's own is never merged in), and secret references are resolved here,
 * at the last moment, and never appear in an error or a log line this module produces.
 *
 * Failure. A process that does not become ready, or exits first, fails the whole start, and
 * everything already started is stopped before the failure is reported. A process that exits
 * later is reported to `onExit`; the supervisor does not restart it, because whether to restart
 * is the driver's decision. Interruption stops what was started.
 *
 * Adoption. After a Platform restart the Agent may still be running a Project's processes.
 * `adoptProcessPlan` matches them to the plan by executable, arguments and directory, and
 * refuses anything unrelated.
 */

const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_GRACE_MS = 10_000;
const START_CONCURRENCY = 4;
const MAX_LOG_LINES = 500;

export interface PlanSupervisorOptions {
  readonly runner: ZelavisAgentProcessRunner;
  /** What the Agent calls this workload; a Project id. */
  readonly workloadId: string;
  /** Placement authority the Agent checks, when it fences placements. */
  readonly placement?: AgentPlacementIdentity;
  readonly cwd: string;
  /** Requirement name to absolute executable. */
  readonly commands: Readonly<Record<string, string>>;
  /** Port name to the number allocated for this Project. */
  readonly ports: Readonly<Record<string, number>>;
  /** What every process gets before the plan's own variables. */
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly resolveSecret: (name: string) => Effect.Effect<string, RecipeError>;
  /** Whether something accepts connections on this loopback port right now. */
  readonly probe: (port: number) => Effect.Effect<boolean>;
  /** Whether this file exists right now. */
  readonly pathExists: (path: string) => Effect.Effect<boolean>;
  readonly pollMs?: number;
  readonly stopGraceMs?: number;
  /** A process that exited after the plan was ready, and was not asked to. */
  readonly onExit?: (name: string, exit: ZelavisAgentProcessExit) => void;
  /** Every output line, as it arrives, attributed to its process. */
  readonly onOutput?: (name: string, output: ZelavisAgentProcessOutput) => void;
}

export interface RunningPlan {
  readonly names: readonly string[];
  /** The most recent output lines of all processes, oldest first. */
  readonly logs: () => readonly { readonly process: string; readonly stream: "stdout" | "stderr"; readonly line: string }[];
  /** Whether every process of the plan is present and running. */
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

type PlanProcess = ProcessPlan["processes"][number];

/** Everything the two entry points share: log, exits, resolution and the handle they return. */
function supervision(plan: ProcessPlan, options: PlanSupervisorOptions) {
  const levels = levelsOf(plan);
  const started = new Map<string, ZelavisAgentProcess>();
  const exits = new Map<string, ZelavisAgentProcessExit>();
  const log: { process: string; stream: "stdout" | "stderr"; line: string }[] = [];
  const state = { ready: false };

  const reveal = (value: string | RecipeSecret) => typeof value === "string" ? Effect.succeed(value) : options.resolveSecret(value.secret);
  const record = (process: string) => (output: ZelavisAgentProcessOutput) => {
    options.onOutput?.(process, output);
    log.push({ process, stream: output.stream, line: output.line });
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
  };
  const noteExit = (name: string, exit: ZelavisAgentProcessExit) => {
    exits.set(name, exit);
    if (state.ready && !exit.requested) options.onExit?.(name, exit);
  };

  const resolved = (process: PlanProcess) => Effect.gen(function* () {
    const executable = options.commands[process.command];
    if (executable === undefined) return yield* Effect.fail(fail(`"${process.name}" uses "${process.command}", which this host did not provide.`));
    const args = yield* Effect.forEach(process.args, reveal);
    const env: Record<string, string> = { ...options.baseEnvironment };
    for (const [name, value] of Object.entries(process.env)) env[name] = yield* reveal(value);
    return { executable, args, env };
  });

  const stopOne = (name: string) => {
    const child = started.get(name);
    return child === undefined || !child.running
      ? Effect.void
      : integration(() => child.stop({ graceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS })).pipe(
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

  const handle = (): RunningPlan => ({
    names: plan.processes.map((process) => process.name),
    logs: () => [...log],
    running: () => plan.processes.every((process) => started.get(process.name)?.running === true),
    stop: stopAll,
  });
  return { levels, started, exits, state, record, noteExit, resolved, stopAll, handle };
}

export const startProcessPlan = (plan: ProcessPlan, options: PlanSupervisorOptions): Effect.Effect<RunningPlan, RecipeError> =>
  Effect.gen(function* () {
    const poll = options.pollMs ?? DEFAULT_POLL_MS;
    const run = yield* Effect.try({ try: () => supervision(plan, options), catch: () => fail("The process plan cannot be ordered.") });

    const startOne = (process: PlanProcess) =>
      Effect.gen(function* () {
        const { executable, args, env } = yield* run.resolved(process);
        const readiness = process.readiness;
        let probe: () => Effect.Effect<boolean>;
        let waitsOn: string;
        if ("port" in readiness) {
          const port = options.ports[readiness.port];
          if (port === undefined) return yield* Effect.fail(fail(`"${process.name}" waits on port "${readiness.port}", which has no allocation.`));
          probe = () => options.probe(port);
          waitsOn = `port "${readiness.port}"`;
        } else {
          const path = readiness.path;
          probe = () => options.pathExists(path);
          waitsOn = "its readiness file";
        }

        const child = yield* integration(() => options.runner.start({
          workloadId: options.workloadId, ...(options.placement ? { placement: options.placement } : {}),
          executable, args, cwd: options.cwd, env,
        }, {
          onOutput: run.record(process.name),
          onExit: (exit) => run.noteExit(process.name, exit),
        })).pipe(Effect.mapError(() => fail(`"${process.name}" could not be started.`)));
        run.started.set(process.name, child);

        // Ready means the port accepts connections or the file exists; a process that exits first has failed.
        const deadline = Date.now() + readiness.timeoutMs;
        for (;;) {
          const exit = run.exits.get(process.name);
          if (exit !== undefined) {
            return yield* Effect.fail(fail(`"${process.name}" exited before it was ready (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}).`));
          }
          if (yield* probe()) return;
          if (Date.now() >= deadline) {
            return yield* Effect.fail(fail(`"${process.name}" was not ready on ${waitsOn} within ${readiness.timeoutMs} ms.`));
          }
          yield* Effect.sleep(poll);
        }
      });

    // Whatever started is stopped if a later process fails or the start is interrupted.
    yield* Effect.gen(function* () {
      for (const level of run.levels) {
        yield* Effect.forEach(level, startOne, { concurrency: START_CONCURRENCY, discard: true });
      }
    }).pipe(Effect.onError(() => run.stopAll.pipe(Effect.orElseSucceed(() => undefined))));

    run.state.ready = true;
    return run.handle();
  });

const sameArguments = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Takes back the processes an Agent kept running for this Project. Each must match a process of
 * the plan exactly (executable, arguments, directory); an unrelated one is refused rather than
 * adopted. A plan with fewer processes alive than it declares is returned as not `running()`, so
 * the driver can stop what is left and start again.
 */
export const adoptProcessPlan = (plan: ProcessPlan, attached: readonly ZelavisAgentAttachedProcess[], options: PlanSupervisorOptions): Effect.Effect<RunningPlan, RecipeError> =>
  Effect.gen(function* () {
    const run = yield* Effect.try({ try: () => supervision(plan, options), catch: () => fail("The process plan cannot be ordered.") });
    const expected = yield* Effect.forEach(plan.processes, (process) => run.resolved(process).pipe(Effect.map((value) => ({ process, ...value }))));
    const claimed = new Set<string>();
    for (const entry of attached) {
      const match = expected.find(({ process, executable, args }) =>
        !claimed.has(process.name) && entry.command.executable === executable && entry.command.cwd === options.cwd &&
        sameArguments(entry.command.args ?? [], args));
      if (!match || entry.process.workloadId !== options.workloadId || !entry.process.listen) {
        return yield* Effect.fail(fail("The Agent returned a process that does not belong to this Project's plan."));
      }
      claimed.add(match.process.name);
      run.started.set(match.process.name, entry.process);
      const note = run.record(match.process.name);
      entry.process.listen(note);
      for (const output of entry.replay) note(output);
      // The Agent's own record of when it ends; reported like any exit after readiness.
      Effect.runFork(integration(() => entry.process.exit).pipe(
        Effect.tap((exit) => Effect.sync(() => run.noteExit(match.process.name, exit))),
        Effect.orElseSucceed(() => undefined),
      ));
    }
    run.state.ready = true;
    return run.handle();
  });
