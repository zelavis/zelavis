import { Context, Effect, Schema } from "effect";
import type { RecipeManifest, RecipeMethod } from "./manifest.js";

export class RecipeError extends Schema.TaggedError<RecipeError>()(
  "RecipeError", { operation: Schema.String, message: Schema.String },
) {}

/** References keep generated credentials out of plans and progress records. */
export interface RecipeSecret { readonly secret: string }
export interface ProcessPlan {
  readonly processes: readonly {
    readonly name: string;
    /** Requirement catalogue executable, never an arbitrary host path. */
    readonly command: string;
    readonly args: readonly (string | RecipeSecret)[];
    readonly env: Readonly<Record<string, string | RecipeSecret>>;
    readonly dependsOn: readonly string[];
    readonly readiness: {
      readonly port: string;
      readonly timeoutMs: number;
    };
  }[];
}

const PlanName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const PlanText = Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^[^\x00]*$/));
const PlanValue = Schema.Union([PlanText, Schema.Struct({ secret: PlanName })]);
const ProcessPlanWire = Schema.Struct({
  processes: Schema.Array(Schema.Struct({
    name: PlanName,
    command: PlanName,
    args: Schema.Array(PlanValue).check(Schema.isMaxLength(128)),
    env: Schema.Record(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)), PlanValue),
    dependsOn: Schema.Array(PlanName).check(Schema.isMaxLength(64)),
    readiness: Schema.Struct({
      port: PlanName,
      timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900000 })),
    }),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

/** Validate before supervision; executable names come from the host requirements catalogue. */
export function parseProcessPlan(input: unknown, allowed: {
  readonly commands: readonly string[];
  readonly ports: readonly string[];
}): ProcessPlan {
  try {
    let plan: typeof ProcessPlanWire.Type;
    try {
      plan = Schema.decodeUnknownSync(ProcessPlanWire)(input, { onExcessProperty: "error" });
    } catch {
      throw new RecipeError({ operation: "start", message: "Process plan does not match the supervision contract." });
    }
    const processes = new Map(plan.processes.map((process) => [process.name, process]));
    if (processes.size !== plan.processes.length) throw new Error("Duplicate process names.");
    for (const process of plan.processes) {
      if (!allowed.commands.includes(process.command)) throw new Error(`Undeclared executable "${process.command}".`);
      if (!allowed.ports.includes(process.readiness.port)) throw new Error(`Undeclared port "${process.readiness.port}".`);
      if (Object.keys(process.env).length > 128) throw new Error("Too many environment entries.");
      if (new Set(process.dependsOn).size !== process.dependsOn.length) throw new Error("Duplicate process dependencies.");
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function visit(name: string): void {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error("Process dependencies contain a cycle.");
      const process = processes.get(name);
      if (!process) throw new Error(`Unknown process dependency "${name}".`);
      visiting.add(name);
      for (const dependency of process.dependsOn) visit(dependency);
      visiting.delete(name);
      visited.add(name);
    }
    for (const name of processes.keys()) visit(name);
    return Object.freeze({ processes: Object.freeze(plan.processes.map((process) => Object.freeze({
      ...process,
      args: Object.freeze(process.args.map((value) => typeof value === "string" ? value : Object.freeze({ ...value }))),
      env: Object.freeze(Object.fromEntries(Object.entries(process.env).map(([key, value]) =>
        [key, typeof value === "string" ? value : Object.freeze({ ...value })]))),
      dependsOn: Object.freeze([...process.dependsOn]),
      readiness: Object.freeze({ ...process.readiness }),
    }))) });
  } catch (cause) {
    if (cause instanceof RecipeError) throw cause;
    throw new RecipeError({ operation: "start", message: `Invalid process plan: ${String(cause)}` });
  }
}

export interface RecipeContext {
  readonly projectId: string;
  readonly hostname: string;
  readonly software: RecipeManifest["software"][number];
  readonly method: RecipeMethod;
  readonly config: Readonly<Record<string, string | number | boolean | RecipeSecret>>;
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * Adapters enforce relative paths (including symlinks), declared executables,
 * bounded downloads/output and cancellation. This service is not a JS sandbox.
 * No API here installs host packages or grants privileged execution.
 */
export interface RecipeHostApi {
  readonly files: {
    readonly read: (path: string) => Effect.Effect<string, RecipeError>;
    readonly write: (path: string, content: string | RecipeSecret) => Effect.Effect<void, RecipeError>;
    readonly mkdir: (path: string) => Effect.Effect<void, RecipeError>;
    readonly remove: (path: string) => Effect.Effect<void, RecipeError>;
  };
  readonly download: (input: {
    readonly url: string; readonly sha256: string; readonly maxBytes: number; readonly destination: string;
  }) => Effect.Effect<void, RecipeError>;
  /**
   * Unpacks a `.tar.gz` below the project. `destination` must not exist yet. With
   * `stripTopLevel`, the archive must have exactly one top-level directory, whose
   * contents become the destination (how release archives are usually laid out).
   */
  readonly extract: (archive: string, destination: string, options?: {
    readonly stripTopLevel?: boolean;
  }) => Effect.Effect<void, RecipeError>;
  readonly run: (input: {
    readonly command: string;
    readonly args: readonly (string | RecipeSecret)[];
    readonly env?: Readonly<Record<string, string | RecipeSecret>>;
    readonly timeoutMs: number;
  }) => Effect.Effect<{ readonly code: number; readonly stdout: string; readonly stderr: string }, RecipeError>;
  /** Generates and persists an owner-only credential, returning its opaque reference. */
  readonly secret: (name: string) => Effect.Effect<RecipeSecret, RecipeError>;
  readonly progress: (input: { readonly phase: string; readonly message: string }) => Effect.Effect<void, RecipeError>;
}

export class RecipeHost extends Context.Service<RecipeHost, RecipeHostApi>()("zelavis/recipe/RecipeHost") {}

type Phase<A> = (context: RecipeContext) => Effect.Effect<A, RecipeError, RecipeHost>;
export interface RecipeDefinition {
  readonly install: Phase<void>;
  readonly start: Phase<ProcessPlan>;
  readonly stop?: Phase<void>;
  readonly upgrade?: (context: RecipeContext, previous: RecipeContext["software"])
    => Effect.Effect<void, RecipeError, RecipeHost>;
  readonly backup?: Phase<{ readonly path: string }>;
  readonly remove?: Phase<void>;
}

/** Lifecycle programs remain Effect values; the host owns their scope and execution. */
export function defineRecipe(definition: RecipeDefinition): RecipeDefinition {
  return Object.freeze({ ...definition });
}
