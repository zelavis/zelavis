import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { Duration, Effect } from "effect";
import type { AgentPlacementIdentity } from "../core/agent/placement-lease.js";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { RecipeError, type PlanHostApi } from "../core/recipe/index.js";
import { loopbackPortAccepts } from "./_loopback-probe.js";

/** What a missing configuration file digests to: distinct from every real content. */
export const ABSENT_FILE = "absent";

const failure = (message: string) => new RecipeError({ operation: "start", message });

/**
 * The machine behind a plan controller: the Agent that runs the processes, the loopback ports
 * and files that tell whether they are ready, and the content of the configuration files they
 * read. Everything the controller does to the world goes through here.
 */
export function makeAgentPlanHost(input: {
  readonly runner: ZelavisAgentProcessRunner;
  readonly workloadId: string;
  readonly placement?: AgentPlacementIdentity;
  readonly cwd: string;
  readonly commands: Readonly<Record<string, string>>;
  readonly ports: Readonly<Record<string, number>>;
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly resolveSecret: (name: string) => Effect.Effect<string, RecipeError>;
  readonly onOutput?: PlanHostApi["onOutput"];
  readonly pollInterval?: Duration.Input;
  readonly stopGrace?: Duration.Input;
  readonly disruption?: PlanHostApi["disruption"];
}): PlanHostApi {
  return {
    workloadId: input.workloadId, cwd: input.cwd, commands: input.commands, ports: input.ports,
    baseEnvironment: input.baseEnvironment, resolveSecret: input.resolveSecret,
    ...(input.onOutput ? { onOutput: input.onOutput } : {}),
    ...(input.placement ? { placement: input.placement } : {}),
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
