import { Context, Effect, Schema } from "effect";
import type { RecipeManifest, RecipeMethod } from "./manifest.js";

export class RecipeError extends Schema.TaggedError<RecipeError>()(
  "RecipeError", { operation: Schema.String, message: Schema.String },
) {}

/** References keep generated credentials out of plans and progress records. */
export interface RecipeSecret { readonly secret: string }
/**
 * What the Platform does with a running process when a newer plan still contains it but its
 * configuration changed. `reload` signals it and leaves it serving (nginx and PHP-FPM reload
 * gracefully); `restart` replaces it. The default is `restart`, which is always correct.
 */
export type ProcessUpdate =
  | { readonly strategy: "restart" }
  | { readonly strategy: "reload"; readonly signal: "SIGHUP" | "SIGUSR1" | "SIGUSR2" };

export interface ProcessPlan {
  readonly processes: readonly {
    readonly name: string;
    /** Requirement catalogue executable, never an arbitrary host path. */
    readonly command: string;
    readonly args: readonly (string | RecipeSecret)[];
    readonly env: Readonly<Record<string, string | RecipeSecret>>;
    readonly dependsOn: readonly string[];
    /**
     * Ready when a declared port accepts connections, or when a file (a unix socket, a pid
     * file) exists. A path must lie below the project or its socket directory.
     */
    readonly readiness:
      | { readonly port: string; readonly timeoutMs: number }
      | { readonly path: string; readonly timeoutMs: number };
    /**
     * Files this process reads its configuration from, as absolute paths below the project or its
     * socket directory. Their content is part of the process's identity: when it changes between
     * two plans the process is reloaded or restarted according to `update`, and when it does not
     * the process is left alone.
     */
    readonly config?: readonly string[];
    readonly update?: ProcessUpdate;
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
    readiness: Schema.Union([
      Schema.Struct({ port: PlanName, timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900000 })) }),
      Schema.Struct({
        path: Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^\/[^\x00]*$/)),
        timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900000 })),
      }),
    ]),
    config: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^\/[^\x00]*$/))).check(Schema.isMaxLength(8))),
    update: Schema.optional(Schema.Union([
      Schema.Struct({ strategy: Schema.Literal("restart") }),
      Schema.Struct({ strategy: Schema.Literal("reload"), signal: Schema.Literals(["SIGHUP", "SIGUSR1", "SIGUSR2"]) }),
    ])),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

/** Validate before supervision; executable names come from the host requirements catalogue. */
export function parseProcessPlan(input: unknown, allowed: {
  readonly commands: readonly string[];
  readonly ports: readonly string[];
  /** Absolute directories a readiness path may lie below. */
  readonly directories?: readonly string[];
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
      if ("port" in process.readiness) {
        if (!allowed.ports.includes(process.readiness.port)) throw new Error(`Undeclared port "${process.readiness.port}".`);
      } else {
        const path = process.readiness.path;
        const inside = (allowed.directories ?? []).some((directory) => path.startsWith(`${directory.replace(/\/+$/, "")}/`));
        if (!inside || path.split("/").includes("..")) throw new Error("A readiness path must lie below the project or its socket directory.");
      }
      if (Object.keys(process.env).length > 128) throw new Error("Too many environment entries.");
      if (new Set(process.dependsOn).size !== process.dependsOn.length) throw new Error("Duplicate process dependencies.");
      for (const path of process.config ?? []) {
        const inside = (allowed.directories ?? []).some((directory) => path.startsWith(`${directory.replace(/\/+$/, "")}/`));
        if (!inside || path.split("/").includes("..")) throw new Error("A configuration path must lie below the project or its socket directory.");
      }
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
      readiness: Object.freeze({ ...process.readiness }) as typeof process.readiness,
      ...(process.config ? { config: Object.freeze([...process.config]) } : {}),
      ...(process.update ? { update: Object.freeze({ ...process.update }) as typeof process.update } : {}),
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
  /** Absolute locations a phase needs to write into configuration files. */
  readonly directories: {
    /** Everything the recipe's files API reaches. Phases and processes work here. */
    readonly root: string;
    /** Where unix sockets live: short, and visible to every process of the Project. */
    readonly sockets: string;
  };
  /** The OS account the Project's processes run as. */
  readonly account: {
    readonly user: string;
    readonly group: string;
    /** True when the Platform is root and daemons must drop to this account themselves. */
    readonly switchUser: boolean;
  };
}

/**
 * Adapters enforce relative paths (including symlinks), declared executables,
 * bounded downloads/output and cancellation. This service is not a JS sandbox.
 * No API here installs host packages or grants privileged execution.
 */
export interface RecipeHostApi {
  readonly files: {
    readonly read: (path: string) => Effect.Effect<string, RecipeError>;
    /** Content may be assembled from text and secret references; a file with a secret is private. */
    readonly write: (path: string, content: string | RecipeSecret | readonly (string | RecipeSecret)[]) => Effect.Effect<void, RecipeError>;
    readonly exists: (path: string) => Effect.Effect<boolean, RecipeError>;
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
