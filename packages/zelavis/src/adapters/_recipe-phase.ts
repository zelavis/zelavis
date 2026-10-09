import { spawn } from "node:child_process";
import { realpathSync, writeSync } from "node:fs";
import { chmod, chown, lstat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cause, Effect, Schema } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import {
  RecipeError, RecipeHost, parseProcessPlan,
  type ProcessPlan, type RecipeContext, type RecipeDefinition,
} from "../core/recipe/index.js";
import { TAR_CANDIDATES, createRecipeHost } from "./_recipe-host.js";
import { provideHostPackagesTo } from "./_service-resolution.js";

/**
 * Runs one recipe phase (`install`, `start`, ...) in a process of its own.
 *
 * A recipe is JavaScript. Run inside the Platform it could do anything the Platform can, so a
 * phase never runs there. The parent (`runRecipePhase`, used by the Agent, which starts it as
 * the Project's own OS user) starts a fresh Node with a clean environment and Node's permission
 * model switched on: the child may write only inside the Project's directory and its secrets
 * directory, and may read only that, the recipe's own folder and the packages it loads. The two
 * sides exchange data only: a request in, progress lines and one result out over a private
 * channel (file descriptor 3). What the recipe prints to stdout or stderr is only a log. The
 * recipe shares the channel's descriptor, so the parent validates the result itself.
 *
 * Honest limits. The permission model covers file access made by Node itself. Commands the
 * recipe declared are started from inside the phase (that is what `RecipeHost.run` does), so
 * they can do what the OS user can do; the real boundaries remain the allow-list of official
 * recipes, the OS user, and the audited host-operation broker for anything privileged.
 * The model does not limit network access, CPU or memory beyond the deadline and the output caps.
 */

export type RecipePhaseName = "install" | "start" | "stop" | "upgrade" | "backup" | "remove";

const PHASES: readonly RecipePhaseName[] = ["install", "start", "stop", "upgrade", "backup", "remove"];
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_PROGRESS_EVENTS = 10_000;

/** What the child is given. Plain data: no closures, no secrets, only references. */
export interface RecipePhaseRequest {
  readonly phase: RecipePhaseName;
  /** Absolute path of the recipe's JavaScript module: the verified, frozen artifact. */
  readonly module: string;
  readonly root: string;
  readonly secretsDirectory: string;
  /** Requirement name to absolute executable. */
  readonly commands: Readonly<Record<string, string>>;
  readonly context: RecipeContext;
  /** The software version a project moves away from, for `upgrade`. */
  readonly previous?: RecipeContext["software"];
  /** The names a process plan may use, from the manifest: its requirements and ports. */
  readonly allowed: { readonly commands: readonly string[]; readonly ports: readonly string[]; readonly directories?: readonly string[] };
}

export type RecipePhaseResult =
  | { readonly phase: "start"; readonly plan: ProcessPlan }
  | { readonly phase: "backup"; readonly path: string }
  | { readonly phase: "install" | "stop" | "upgrade" | "remove" };

const Secret = Schema.Struct({ secret: Schema.String });
const Request = Schema.Struct({
  phase: Schema.Literals(PHASES),
  module: Schema.String,
  root: Schema.String,
  secretsDirectory: Schema.String,
  commands: Schema.Record(Schema.String, Schema.String),
  context: Schema.Struct({
    directories: Schema.Struct({ root: Schema.String, sockets: Schema.String, named: Schema.Record(Schema.String, Schema.String) }),
    account: Schema.Struct({ user: Schema.String, group: Schema.String, switchUser: Schema.Boolean }),
    projectId: Schema.String,
    hostname: Schema.String,
    software: Schema.Struct({ version: Schema.String, archive: Schema.String, sha256: Schema.String, maxBytes: Schema.Number }),
    method: Schema.Unknown,
    config: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Secret])),
    ports: Schema.Record(Schema.String, Schema.Number),
  }),
  previous: Schema.optional(Schema.Struct({ version: Schema.String, archive: Schema.String, sha256: Schema.String, maxBytes: Schema.Number })),
  allowed: Schema.Struct({ commands: Schema.Array(Schema.String), ports: Schema.Array(Schema.String), directories: Schema.optional(Schema.Array(Schema.String)) }),
});

const PlanValue = Schema.Unknown;
const ChildMessageWire = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), phase: Schema.String, message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("result"), ok: Schema.Literal(true),
    value: Schema.Union([
      Schema.Struct({ phase: Schema.Literal("start"), plan: PlanValue }),
      Schema.Struct({ phase: Schema.Literal("backup"), path: Schema.String }),
      Schema.Struct({ phase: Schema.Literals(["install", "stop", "upgrade", "remove"]) }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("result"), ok: Schema.Literal(false), operation: Schema.String, message: Schema.String }),
]);

type ChildResult =
  | { readonly type: "result"; readonly ok: true; readonly value: RecipePhaseResult }
  | { readonly type: "result"; readonly ok: false; readonly operation: string; readonly message: string };
type ChildMessage = { readonly type: "progress"; readonly phase: string; readonly message: string } | ChildResult;

export interface RunRecipePhaseOptions extends RecipePhaseRequest {
  /** Deadline for the whole phase. */
  readonly timeoutMs: number;
  readonly progress?: (input: { readonly phase: string; readonly message: string }) => void;
  /** The Node to run the phase with; defaults to the one running this process. */
  readonly nodeExecutable?: string;
  /** Run as the Project's own OS user. Requires the parent to be allowed to switch. */
  readonly uid?: number;
  readonly gid?: number;
}

const fail = (operation: string, message: string) => new RecipeError({ operation, message });

const realOrSelf = (path: string): string => {
  try { return realpathSync(path); } catch { return path; }
};

/** The package directory that holds `name`'s entry, as the host resolves it. */
const packageRoot = (name: string): string => {
  const entry = realOrSelf(createRequire(import.meta.url).resolve(name));
  const marker = `${sep}node_modules${sep}${name}${sep}`;
  const at = entry.lastIndexOf(marker);
  if (at === -1) throw new Error(`Cannot locate the ${name} package.`);
  return entry.slice(0, at + marker.length - 1);
};

/** Directories the child may read: its own code and packages, plus the project and the recipe. */
function readableDirectories(request: RecipePhaseRequest): readonly string[] {
  const zelavis = realOrSelf(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const effect = packageRoot("effect");
  // The host checks each declared executable before it runs one.
  // Both the path as declared and where it really lies: the host stats the first, which may be a link.
  const executables = [...Object.values(request.commands), ...TAR_CANDIDATES].flatMap((path) => [path, realOrSelf(path)]);
  const directories = new Set<string>([...executables, zelavis, effect, realOrSelf(dirname(request.module)), realOrSelf(request.root), realOrSelf(request.secretsDirectory)]);
  // Effect's own dependencies sit beside it: hoisted under npm, in its folder's node_modules under pnpm.
  if (basename(dirname(effect)) === "node_modules") directories.add(dirname(effect));
  // Under pnpm, a package's own dependencies are siblings in the virtual store.
  const marker = `${sep}node_modules${sep}.pnpm${sep}`;
  const at = effect.indexOf(marker);
  if (at !== -1) directories.add(effect.slice(0, at + marker.length - 1));
  return [...directories];
}

export function phaseArguments(request: RecipePhaseRequest, runner: string): readonly string[] {
  const writable = [realOrSelf(request.root), realOrSelf(request.secretsDirectory)];
  return [
    "--permission",
    ...readableDirectories(request).map((directory) => `--allow-fs-read=${directory}`),
    // Resolving the runner itself needs its own file; it is inside the zelavis directory above.
    ...writable.map((directory) => `--allow-fs-write=${directory}`),
    "--allow-child-process",
    "--disallow-code-generation-from-strings",
    "--max-old-space-size=1024",
    runner,
  ];
}

/**
 * The parent trusts nothing the child says. The recipe runs in that process and shares its
 * channel, so a plan or a path is checked again here, against the manifest's own names.
 */
const checkedResult = (options: RunRecipePhaseOptions, value: ChildResult & { readonly ok: true } extends { value: infer V } ? V : never): Effect.Effect<RecipePhaseResult, RecipeError> => {
  if (value.phase === "start") {
    return evaluate(() => parseProcessPlan(value.plan, options.allowed)).pipe(
      Effect.map((plan): RecipePhaseResult => ({ phase: "start", plan })),
      Effect.mapError((error) => error.cause instanceof RecipeError ? error.cause : fail("start", "The process plan is not valid.")),
    );
  }
  if (value.phase === "backup") {
    const path = value.path;
    return path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")
      ? Effect.fail(fail("backup", "The backup path must be relative to the project."))
      : Effect.succeed({ phase: "backup", path });
  }
  return Effect.succeed({ phase: value.phase });
};

const RUNNER = fileURLToPath(new URL("./_recipe-phase-child.js", import.meta.url));

/** Starts the phase in its own process and returns what it decided, or why it could not. */
export const runRecipePhase = (options: RunRecipePhaseOptions): Effect.Effect<RecipePhaseResult, RecipeError> =>
  Effect.gen(function* () {
    if (!PHASES.includes(options.phase)) return yield* Effect.fail(fail(options.phase, "That is not a recipe phase."));
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
      return yield* Effect.fail(fail(options.phase, "The phase deadline is not valid."));
    }
    for (const path of [options.module, options.root, options.secretsDirectory, ...Object.values(options.commands)]) {
      if (!isAbsolute(path)) return yield* Effect.fail(fail(options.phase, "Paths given to a phase must be absolute."));
    }
    const stats = yield* integration(() => lstat(options.module)).pipe(
      Effect.mapError(() => fail(options.phase, "The recipe module does not exist.")),
    );
    if (!stats.isFile() || stats.isSymbolicLink()) return yield* Effect.fail(fail(options.phase, "The recipe module must be a regular file."));

    const request: RecipePhaseRequest = {
      // Real paths: the permission model and module loading both see through links, and the child must name what it may use.
      phase: options.phase, module: realOrSelf(options.module), root: realOrSelf(options.root), secretsDirectory: realOrSelf(options.secretsDirectory),
      commands: options.commands, context: options.context, allowed: options.allowed,
      ...(options.previous === undefined ? {} : { previous: options.previous }),
    };
    // The phase may write only below these, so they exist and belong to its user before it starts.
    const prepared = "The project directories could not be prepared.";
    const prepare = <A>(run: () => Promise<A>) => integration(run).pipe(Effect.mapError(() => fail(options.phase, prepared)));
    yield* prepare(() => mkdir(request.root, { recursive: true }));
    yield* prepare(() => mkdir(request.secretsDirectory, { recursive: true, mode: 0o700 }));
    yield* prepare(() => chmod(request.secretsDirectory, 0o700));
    if (options.uid !== undefined && options.gid !== undefined) {
      const { uid, gid } = options;
      yield* prepare(() => chown(request.root, uid, gid));
      yield* prepare(() => chown(request.secretsDirectory, uid, gid));
    }
    const args = yield* evaluate(() => phaseArguments(request, RUNNER)).pipe(
      Effect.mapError(() => fail(options.phase, "The phase process could not be prepared.")),
    );

    return yield* Effect.callback<RecipePhaseResult, RecipeError>((resume) => {
      const child = spawn(options.nodeExecutable ?? process.execPath, [...args], {
        cwd: options.root,
        // Nothing of the Platform's environment: no tokens, no paths, no proxies.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: options.root, LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: true,
        shell: false,
        ...(options.uid === undefined ? {} : { uid: options.uid }),
        ...(options.gid === undefined ? {} : { gid: options.gid }),
      });
      let settled = false;
      let pending = "";
      let protocolBytes = 0;
      let events = 0;
      let result: ChildResult | undefined;
      const log = { size: 0 };
      const killGroup = () => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const finish = (outcome: Effect.Effect<RecipePhaseResult, RecipeError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup();
        resume(outcome);
      };
      const timer = setTimeout(() => finish(Effect.fail(fail(options.phase, `The ${options.phase} phase did not finish within ${options.timeoutMs} ms and was stopped.`))), options.timeoutMs);

      const accept = (line: string) => {
        let message: ChildMessage;
        try { message = Schema.decodeUnknownSync(ChildMessageWire)(JSON.parse(line), { onExcessProperty: "error" }) as ChildMessage; } catch { return finish(Effect.fail(fail(options.phase, "The phase sent something that is not a message."))); }
        if (message.type === "progress" && typeof message.phase === "string" && typeof message.message === "string") {
          events += 1;
          if (events > MAX_PROGRESS_EVENTS) return finish(Effect.fail(fail(options.phase, "The phase reported too much progress.")));
          options.progress?.({ phase: message.phase.slice(0, 64), message: message.message.slice(0, 500) });
          return;
        }
        if (message.type === "result" && result === undefined) { result = message; return; }
        finish(Effect.fail(fail(options.phase, "The phase sent an unexpected message.")));
      };
      child.stdio[3]!.on("data", (chunk: Buffer) => {
        protocolBytes += chunk.length;
        if (protocolBytes > MAX_PROTOCOL_BYTES) return finish(Effect.fail(fail(options.phase, "The phase sent more than it may.")));
        pending += chunk.toString("utf8");
        if (pending.length > MAX_LINE_BYTES && !pending.includes("\n")) return finish(Effect.fail(fail(options.phase, "The phase sent a line that is too long.")));
        for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length > 0) accept(line);
          if (settled) return;
        }
      });
      // What the recipe prints is its own log; it is drained so it cannot block, and never trusted as a result.
      const drain = (chunk: Buffer) => { log.size += chunk.length; if (log.size > MAX_LOG_BYTES * 8) finish(Effect.fail(fail(options.phase, "The phase wrote far more output than it may."))); };
      child.stdout!.on("data", drain);
      child.stderr!.on("data", drain);
      child.once("error", () => finish(Effect.fail(fail(options.phase, "The phase process could not be started."))));
      child.once("close", (code) => {
        if (settled) return;
        if (result === undefined) return finish(Effect.fail(fail(options.phase, `The ${options.phase} phase ended without a result (exit ${code ?? "signal"}).`)));
        if (!result.ok) return finish(Effect.fail(fail(result.operation, result.message)));
        finish(checkedResult(options, result.value));
      });
      child.stdin!.end(`${JSON.stringify(request)}\n`);
      return Effect.sync(() => { if (!settled) { settled = true; clearTimeout(timer); killGroup(); } });
    });
  });

// ---- The child's side. Only `_recipe-phase-child.ts` calls this. -----------------------------------

const send = (message: ChildMessage) => writeSync(3, `${JSON.stringify(message)}\n`);

/** Reads one request from stdin, runs the phase, reports the result. Never returns normally. */
export const runPhaseInChild = (stdin: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const decoded = yield* evaluate(() => Schema.decodeUnknownSync(Request)(JSON.parse(stdin), { onExcessProperty: "error" })).pipe(
      Effect.mapError(() => fail("phase", "The request does not match the phase contract.")),
    );
    const request = decoded as unknown as RecipePhaseRequest;
    // `zelavis` and `effect` come from the host, exactly as for a loaded service.
    yield* evaluate(() => provideHostPackagesTo(dirname(request.module)));
    const loaded = yield* integration(() => import(pathToFileURL(request.module).href) as Promise<{ default?: RecipeDefinition }>).pipe(
      Effect.mapError(() => fail(request.phase, "The recipe module could not be loaded.")),
    );
    const definition = loaded.default;
    if (!definition || typeof definition.install !== "function" || typeof definition.start !== "function") {
      return yield* Effect.fail(fail(request.phase, "The recipe module must default-export defineRecipe({ install, start, ... })."));
    }
    const host = createRecipeHost({
      root: request.root, secretsDirectory: request.secretsDirectory, commands: request.commands,
      progress: (entry) => send({ type: "progress", ...entry }),
    });
    const run = <A>(program: Effect.Effect<A, RecipeError, RecipeHost>) => program.pipe(Effect.provideService(RecipeHost, host));
    switch (request.phase) {
      case "start": {
        const plan = yield* run(definition.start(request.context));
        const parsed = yield* evaluate(() => parseProcessPlan(plan, request.allowed)).pipe(
          Effect.mapError((error) => error.cause instanceof RecipeError ? error.cause : fail("start", "The process plan is not valid.")),
        );
        send({ type: "result", ok: true, value: { phase: "start", plan: parsed } });
        return;
      }
      case "backup": {
        if (!definition.backup) return yield* Effect.fail(fail("backup", "This recipe has no backup phase."));
        const made = yield* run(definition.backup(request.context));
        if (typeof made?.path !== "string" || made.path.length === 0 || made.path.length > 1024 || made.path.startsWith("/") || made.path.split("/").includes("..")) {
          return yield* Effect.fail(fail("backup", "The backup path must be relative to the project."));
        }
        send({ type: "result", ok: true, value: { phase: "backup", path: made.path } });
        return;
      }
      case "upgrade": {
        if (!definition.upgrade) return yield* Effect.fail(fail("upgrade", "This recipe has no upgrade phase."));
        if (!request.previous) return yield* Effect.fail(fail("upgrade", "An upgrade needs the software version it moves from."));
        yield* run(definition.upgrade(request.context, request.previous));
        send({ type: "result", ok: true, value: { phase: "upgrade" } });
        return;
      }
      case "stop":
      case "remove": {
        const phase = definition[request.phase];
        if (phase) yield* run(phase(request.context));
        send({ type: "result", ok: true, value: { phase: request.phase } });
        return;
      }
      case "install": {
        yield* run(definition.install(request.context));
        send({ type: "result", ok: true, value: { phase: "install" } });
        return;
      }
    }
  }).pipe(
    // A typed failure carries its own words; anything else (a throw inside the recipe, a denied
    // file access) is reported without its text, which may name paths on this machine.
    Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause);
      send({
        type: "result", ok: false,
        operation: error instanceof RecipeError ? error.operation : "phase",
        message: error instanceof RecipeError ? error.message : "The phase failed.",
      });
    })),
  );
