import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { Duration, Effect } from "effect";
import type { AgentPlacementIdentity } from "../core/agent/placement-lease.js";
import type { ZelavisAgentProcessCommand, ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { RecipeError, type PlanHostApi } from "../core/recipe/index.js";
import { loopbackPortAccepts } from "./_loopback-probe.js";

/** What a missing configuration file digests to: distinct from every real content. */
export const ABSENT_FILE = "absent";

const failure = (message: string) => new RecipeError({ operation: "start", message });

/**
 * Stops the workload's uncontrolled processes that run exactly `command`. The Agent hands out only processes no
 * live connection drives, so a process this controller (or any live one) started is never among them.
 */
const reclaimIdentical = (runner: ZelavisAgentProcessRunner, command: ZelavisAgentProcessCommand, grace: Duration.Input) =>
  integration(() => runner.attach!(command.workloadId)).pipe(
    Effect.flatMap((attached) => {
      const same = attached.filter((entry) => entry.process.running && entry.command.executable === command.executable &&
        entry.command.cwd === command.cwd && (entry.command.args?.length ?? 0) === (command.args?.length ?? 0) &&
        (command.args ?? []).every((value, index) => entry.command.args?.[index] === value));
      return Effect.forEach(same, (entry) => integration(() => entry.process.stop({ graceMs: Duration.toMillis(Duration.fromInputUnsafe(grace)) })),
        { concurrency: 4, discard: true }).pipe(Effect.as(same.length));
    }),
    Effect.mapError(() => failure("Leftover processes could not be stopped before a start.")),
  );

/**
 * The machine behind a plan controller: the Agent that runs the processes, the loopback ports
 * and files that tell whether they are ready, and the content of the configuration files they
 * read. Everything the controller does to the world goes through here.
 */
export function makeAgentPlanHost(input: {
  readonly runner: ZelavisAgentProcessRunner;
  readonly workloadId: string;
  /**
   * The placement the Platform holds for the workload now. Read each time a process starts, never captured:
   * a controller made by adoption knows none until the Platform next hands one over (a start or an update),
   * and an Agent refuses a Project process that names none.
   */
  readonly placement?: () => AgentPlacementIdentity | undefined;
  /** Read at every launch and adoption: an upgrade to another layout moves it. */
  readonly cwd: string | (() => string);
  readonly commands: () => Readonly<Record<string, string>>;
  readonly ports: Readonly<Record<string, number>>;
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly resolveSecret: (name: string) => Effect.Effect<string, RecipeError>;
  readonly onOutput?: PlanHostApi["onOutput"];
  readonly pollInterval?: Duration.Input;
  readonly stopGrace?: Duration.Input;
  readonly disruption?: PlanHostApi["disruption"];
}): PlanHostApi {
  const placement = input.placement;
  return {
    workloadId: input.workloadId, commands: input.commands, ports: input.ports,
    get cwd() { return typeof input.cwd === "function" ? input.cwd() : input.cwd; },
    baseEnvironment: input.baseEnvironment, resolveSecret: input.resolveSecret,
    ...(input.onOutput ? { onOutput: input.onOutput } : {}),
    // A getter on the host itself: a spread would copy the value once, at creation.
    get placement() { return placement?.(); },
    ...(input.disruption ? { disruption: input.disruption } : {}),
    pollInterval: input.pollInterval ?? Duration.millis(250),
    stopGrace: input.stopGrace ?? Duration.seconds(10),
    start: (command, options) => integration(() => input.runner.start(command, options)).pipe(
      Effect.mapError(() => failure("A process could not be started."))),
    stop: (process, grace) => integration(() => process.stop({ graceMs: Duration.toMillis(Duration.fromInputUnsafe(grace)) })).pipe(
      Effect.asVoid, Effect.mapError(() => failure("A process could not be stopped."))),
    signal: (process, signal) => process.signal === undefined
      ? Effect.fail(failure("This Agent cannot signal a process."))
      : integration(() => process.signal!(signal)).pipe(
          Effect.flatMap((sent) => sent ? Effect.void : Effect.fail(failure("The process could not be signalled."))),
          Effect.mapError((error) => error instanceof RecipeError ? error : failure("The process could not be signalled."))),
    ...(input.runner.attach ? { reclaim: (command) => reclaimIdentical(input.runner, command, input.stopGrace ?? Duration.seconds(10)) } : {}),
    digest: (text) => Effect.sync(() => createHash("sha256").update(text).digest("hex")),
    probePort: loopbackPortAccepts,
    pathExists: (path) => integration(() => access(path)).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    digestFile: (path) => integration(() => readFile(path)).pipe(
      Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
      Effect.catch((error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? Effect.succeed(ABSENT_FILE) : Effect.fail(failure("A configuration file could not be read."))),
    ),
  };
}
