import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Effect, Fiber, PubSub } from "effect";
import {
  PlanHost, RecipeError, makePlanController, parseRecipeManifest,
  type PlanController, type RecipeContext, type RecipeManifest,
} from "../core/recipe/index.js";
import { evaluate, integration, unwrapFailure, type EffectOperations } from "../core/runtime/effect-boundary.js";
import { objectFields, optional, recordOf, isString, isFiniteNumber, isBoolean, isUnknown, parseJson } from "../core/json-validation.js";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import { ZelavisProjectRuntimeError } from "../project.js";
import type { ZelavisProjectLogEntry, ZelavisProjectRecipeLock, ZelavisProjectRecord, ZelavisProjectRuntimeDriver, ZelavisProjectRuntimeUpdate } from "../project.js";
import { defineEffectProjectRuntime } from "./project-runtime.js";
import { makeAgentPlanHost } from "./_plan-host.js";
import { RequirementUnavailable, resolveRequirementCommands } from "./_recipe-requirements.js";
import { runRecipePhase, type RecipePhaseName } from "./_recipe-phase.js";
import { adoptionPending, applyAdoption, commitAdoption, detectAdoption, revertAdoption, type AdoptedValues } from "./_recipe-adoption.js";
import { relocateDirectories } from "./_recipe-relocation.js";
import { clearPlanState, readPlanState, writePlanState } from "./_recipe-plan-state.js";
import { UpgradeKit, type UpgradeKitApi, applyRecipeUpdate, prepareRecipeUpdate, recoverRecipeUpdate, settleRecipeUpdate } from "./_recipe-upgrade.js";
import { preparedProjectRecord } from "./_project-record-validation.js";

/**
 * A Project runtime driven by a recipe's phases.
 *
 * The recipe says what to install and what to run (`defineRecipe`); this driver owns everything
 * about a host: where a Project's files, secrets and sockets live, which executables exist, the
 * ports it may use, the OS account its processes run as, running each phase in a process of its
 * own, supervising the process plan `start` returns, and taking such processes back after the
 * Platform restarts. A recipe therefore carries no process management, no privilege handling and
 * no knowledge of Debian versus macOS.
 *
 * Layout under `<directory>/<project id>`:
 * - `app/`: everything the recipe's files API reaches. Site files, data and configuration.
 * - `.zelavis/secrets/`: generated credentials, outside `app/` so no recipe path reaches them.
 * - `.zelavis/recipe-state.json`: ports, socket identity, resolved executables, install progress.
 * - `project.json`: the descriptor other parts of the Platform read.
 * Unix sockets live in a short directory beside `directory` on Linux, because separate systemd
 * units have separate private temp directories and a socket path has a length limit.
 *
 * Install runs once per Project (progress is recorded only when it completes, so an interrupted
 * install runs again from the start and the recipe's install must be able to resume).
 */

export interface RecipeProjectRuntimeOptions {
  /** The driver's name, shown in capabilities and logs. */
  readonly name: string;
  readonly description: string;
  /** The directory holding every Project's directory. */
  readonly directory: string;
  /** The recipe's package folder, the digest-verified frozen copy. */
  readonly packageDirectory: string;
  readonly agent: ZelavisAgentProcessRunner;
  /** Account the processes run as when the Platform is root; refused, not replaced, when it does not exist. */
  readonly user?: string;
  readonly installTimeoutMs?: number;
  /**
   * Finding and freezing another version of this recipe, which is what upgrading a running Project
   * needs. Absent, a running Project is not upgraded in place.
   */
  readonly recipes?: {
    readonly source: (name: string, version: string) => Promise<string | undefined>;
    readonly stage: (source: string, dataDirectory: string) => Promise<{ readonly digest: string }>;
    readonly digest: (packageDirectory: string) => Promise<string>;
  };
}

interface RecipeState {
  readonly v: 1;
  readonly ports: Readonly<Record<string, number>>;
  readonly socketId: string;
  readonly commands: Readonly<Record<string, string>>;
  readonly method: string;
  readonly software: string;
  readonly installed: boolean;
  /** Digest of the frozen recipe whose install phase last completed. A different lock means install runs again. */
  readonly installedFor?: string;
  /** Where each of the recipe's named data directories is now, relative to the root (see the manifest's `directories`). */
  readonly layout?: Readonly<Record<string, string>>;
}

const stateRecord = objectFields<RecipeState>({
  v: (value): value is 1 => value === 1,
  ports: (value): value is Readonly<Record<string, number>> => value !== null && typeof value === "object" && Object.values(value).every(isFiniteNumber),
  socketId: (value): value is string => isString(value) && /^[A-Za-z0-9_-]{1,40}$/.test(value),
  commands: (value): value is Readonly<Record<string, string>> => value !== null && typeof value === "object" && Object.values(value).every(isString),
  method: isString, software: isString, installed: isBoolean, installedFor: optional(isString), layout: optional(recordOf(isString)),
});

const packageRecord = objectFields<{ zelavis?: { project?: { install?: unknown } } }>({
  zelavis: optional(objectFields<{ project?: { install?: unknown } }>({
    project: optional(objectFields<{ install?: unknown }>({ install: optional(isUnknown) })),
  })),
});

const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60_000;
const PHASE_TIMEOUT_MS = 2 * 60_000;
const LOG_LIMIT = 500;
const SECRET_NAME = /^[a-z][a-z0-9-]{0,63}$/;

const failure = (message: string) => new ZelavisProjectRuntimeError(message);
/** Any way a recipe, requirement or phase failed, as the one error a Project start reports. */
const asRuntimeError = (error: unknown): ZelavisProjectRuntimeError => {
  const cause = unwrapFailure(error);
  if (cause instanceof ZelavisProjectRuntimeError) return cause;
  if (cause instanceof RecipeError || cause instanceof RequirementUnavailable) return failure(cause.message);
  return failure(cause instanceof Error ? cause.message : String(cause));
};

const availablePort = () => Effect.callback<number, ZelavisProjectRuntimeError>((resume) => {
  const server = createServer();
  server.once("error", () => resume(Effect.fail(failure("Could not allocate a port for the Project."))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") { resume(Effect.fail(failure("Could not allocate a port for the Project."))); return; }
    server.close(() => resume(Effect.succeed(address.port)));
  });
  return Effect.sync(() => { if (server.listening) server.close(); });
});

const output = (executable: string, args: readonly string[]) =>
  Effect.callback<{ code: number; stdout: string }, never>((resume) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "ignore"], shell: false });
    let stdout = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => { if (!settled) { settled = true; resume(Effect.succeed({ code: 127, stdout: "" })); } });
    child.once("close", (code) => { if (!settled) { settled = true; resume(Effect.succeed({ code: code ?? 1, stdout })); } });
    return Effect.sync(() => { if (!settled) { settled = true; child.kill("SIGKILL"); } });
  });

interface Account { readonly user: string; readonly group: string; readonly uid?: number; readonly gid?: number; readonly switchUser: boolean }

/** Root runs the daemons as an unprivileged account (named, or the first of the usual ones); anyone else as themselves. */
const resolveAccount = (configured: string | undefined): Effect.Effect<Account, ZelavisProjectRuntimeError> =>
  Effect.gen(function* () {
    if (process.getuid?.() !== 0) {
      const group = yield* output("id", ["-gn"]);
      return { user: userInfo().username, group: group.code === 0 && group.stdout.trim() ? group.stdout.trim() : userInfo().username, switchUser: false };
    }
    for (const name of configured ? [configured] : ["www-data", "mysql", "nobody"]) {
      const uid = yield* output("id", ["-u", name]);
      const gid = yield* output("id", ["-g", name]);
      // The group's name, not the user's: they coincide on Debian and not on macOS, and PHP-FPM wants the name.
      const group = yield* output("id", ["-gn", name]);
      if (uid.code === 0 && gid.code === 0 && group.code === 0) {
        return { user: name, group: group.stdout.trim(), uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()), switchUser: true };
      }
    }
    return yield* Effect.fail(failure(configured
      ? `The Project runtime is configured to run as "${configured}", but no such account exists on this host.`
      : "The Platform is running as root and found no unprivileged account to run Project daemons as (www-data, mysql or nobody). " +
        "Create one, name one with the runtime's `user` option, or run Zelavis as an ordinary user."));
  });

/**
 * Plan controllers by Agent. Whoever has the Agent sees the Project's running processes, which is
 * what lets an upgraded recipe's driver (a new instance, made from the new package) carry on with
 * processes the old instance started.
 */
const controllersByAgent = new WeakMap<ZelavisAgentProcessRunner, Map<string, PlanController>>();

export function createRecipeProjectRuntime(options: RecipeProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
  const projectsDirectory = resolve(options.directory);
  const agent = options.agent;
  const logs = new Map<string, ZelavisProjectLogEntry[]>();
  const listeners = new Map<string, Fiber.Fiber<void, never>>();
  const controllers = controllersByAgent.get(agent) ?? new Map<string, PlanController>();
  controllersByAgent.set(agent, controllers);
  let accountOnce: Account | undefined;

  const readManifest = (packageDirectory: string): Effect.Effect<RecipeManifest, ZelavisProjectRuntimeError> => Effect.gen(function* () {
    const text = yield* integration(() => readFile(join(packageDirectory, "package.json"), "utf8")).pipe(
      Effect.mapError(() => failure("The recipe package has no readable package.json.")));
    const parsed = yield* evaluate(() => parseJson(text, packageRecord).zelavis?.project?.install).pipe(
      Effect.mapError(() => failure("The recipe package.json is not valid JSON.")));
    if (parsed === undefined) return yield* Effect.fail(failure("The recipe declares no zelavis.project.install."));
    return yield* evaluate(() => parseRecipeManifest(parsed)).pipe(Effect.mapError(asRuntimeError));
  });
  const manifest = readManifest(options.packageDirectory);

  const account = Effect.fn("RecipeRuntime.account")(function* () {
    accountOnce ??= yield* resolveAccount(options.user);
    return accountOnce;
  });

  const paths = (id: string) => {
    const project = join(projectsDirectory, id);
    return {
      project, root: join(project, "app"), zelavis: join(project, ".zelavis"),
      secrets: join(project, ".zelavis", "secrets"), state: join(project, ".zelavis", "recipe-state.json"),
      planState: join(project, ".zelavis", "plan-state.json"), descriptor: join(project, "project.json"),
    };
  };
  /** Short and shared by every unit: separate systemd units have separate private temp directories. */
  const socketDirectory = (state: Pick<RecipeState, "socketId">) =>
    join(process.platform === "linux" ? resolve(projectsDirectory, "..", "runtime-sockets") : "/tmp", `zv-${state.socketId}`);

  const readState = (id: string) => integration(() => readFile(paths(id).state, "utf8")).pipe(
    Effect.flatMap((text) => evaluate(() => parseJson(text, stateRecord))),
    Effect.mapError(() => failure(`Project "${id}" has no recipe state; prepare it first.`)),
  );
  const readStateIfPresent = (id: string) => readState(id).pipe(Effect.map((state): RecipeState | undefined => state), Effect.orElseSucceed(() => undefined));
  const writeState = (id: string, state: RecipeState) =>
    integration(() => writeFile(paths(id).state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })).pipe(Effect.mapError(asRuntimeError));

  const log = (id: string, stream: ZelavisProjectLogEntry["stream"], message: string) => {
    const entries = logs.get(id) ?? [];
    for (const line of message.split("\n").filter(Boolean)) entries.push({ timestamp: new Date().toISOString(), stream, message: line });
    if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
    logs.set(id, entries);
  };

  /** The account must be able to walk down to its Project; the Platform's parents may be private. */
  const ensureTraversable = (from: string, owner: { uid?: number }) => Effect.gen(function* () {
    let current = resolve(from);
    for (;;) {
      const info = yield* integration(() => stat(current)).pipe(Effect.orElseSucceed(() => undefined));
      if (!info) return;
      if (info.uid !== owner.uid && (info.mode & 0o001) === 0) {
        if (info.uid !== process.getuid?.()) return;
        yield* integration(() => chmod(current, info.mode | 0o001)).pipe(Effect.orElseSucceed(() => undefined));
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  });

  /** The manifest's named directories where the Project has them now. */
  const namedDirectories = (id: string, state: RecipeState, parsed: RecipeManifest) =>
    Object.fromEntries((parsed.directories ?? []).map((directory) => [directory.name, join(paths(id).root, state.layout?.[directory.name] ?? directory.path)]));

  const context = (project: { id: string }, state: RecipeState, parsed: RecipeManifest, software: RecipeContext["software"], method: RecipeContext["method"], owner: Account): RecipeContext => ({
    projectId: project.id,
    hostname: "localhost",
    software, method, config: {}, ports: state.ports,
    directories: { root: paths(project.id).root, sockets: socketDirectory(state), named: namedDirectories(project.id, state, parsed) },
    account: { user: owner.user, group: owner.group, switchUser: owner.switchUser },
  });

  const allowedNames = (id: string, state: RecipeState, parsed: RecipeManifest) =>
    ({ commands: Object.keys(state.commands), ports: parsed.ports.map((port) => port.name), directories: [paths(id).root, socketDirectory(state)] });

  /** Runs one phase of a recipe package: the Project's own, or a candidate being staged for an upgrade. */
  const phase = Effect.fn("RecipeRuntime.phase")(function* (
    id: string, name: RecipePhaseName, state: RecipeState, parsed: RecipeManifest, timeoutMs: number, packageDirectory = options.packageDirectory,
  ) {
    const owner = yield* account();
    const method = parsed.methods.find((candidate) => candidate.id === state.method && candidate.driver === "js");
    const software = parsed.software.find((candidate) => candidate.version === state.software);
    if (!method || method.driver !== "js" || !software) return yield* Effect.fail(failure("The recipe no longer offers this Project's install method and software version."));
    const where = paths(id);
    return yield* runRecipePhase({
      phase: name, module: resolve(packageDirectory, method.entry), root: where.root, secretsDirectory: where.secrets,
      commands: state.commands, context: context({ id }, state, parsed, software, method, owner),
      allowed: allowedNames(id, state, parsed),
      timeoutMs, progress: (entry) => log(id, "system", `[${entry.phase}] ${entry.message}`),
      ...(owner.uid !== undefined && owner.gid !== undefined ? { uid: owner.uid, gid: owner.gid } : {}),
    }).pipe(Effect.mapError(asRuntimeError));
  });

  const resolveSecret = (id: string) => (name: string) =>
    SECRET_NAME.test(name)
      ? integration(() => readFile(join(paths(id).secrets, name), "utf8")).pipe(
          Effect.mapError(() => new RecipeError({ operation: "start", message: `The secret "${name}" does not exist.` })))
      : Effect.fail(new RecipeError({ operation: "start", message: "A secret name is not valid." }));

  type PlacementToken = Parameters<NonNullable<ZelavisProjectRuntimeDriver["start"]>>[1];

  /** A plan controller for a Project, listening to what its processes do so the Project's log tells it. */
  const createController = Effect.fn("RecipeRuntime.controller")(function* (id: string, state: RecipeState, placement?: PlacementToken) {
    const host = makeAgentPlanHost({
      runner: agent, workloadId: id, cwd: paths(id).root, commands: state.commands, ports: state.ports,
      ...(placement ? { placement: placement as never } : {}),
      baseEnvironment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: paths(id).root, LANG: "C.UTF-8" },
      resolveSecret: resolveSecret(id),
      onOutput: (name, line) => log(id, line.stream, `[${name}] ${line.line}`),
    });
    const controller = yield* makePlanController.pipe(Effect.provideService(PlanHost, host));
    const listener = yield* Effect.forkDetach(Effect.scoped(Effect.gen(function* () {
      const events = yield* PubSub.subscribe(controller.events);
      for (;;) {
        const event = yield* PubSub.take(events);
        log(id, "system", event._tag === "Exited"
          ? `[${event.name}] exited unexpectedly (${event.signal ? `signal ${event.signal}` : `code ${event.code}`})`
          : event._tag === "Reloaded" ? `[${event.name}] reloaded (${event.signal})` : `[${event.name}] ${event._tag.toLowerCase()}`);
      }
    })));
    listeners.set(id, listener);
    controllers.set(id, controller);
    return controller;
  });

  const forget = (id: string) => Effect.gen(function* () {
    controllers.delete(id);
    const listener = listeners.get(id);
    listeners.delete(id);
    if (listener) yield* Fiber.interrupt(listener);
  });

  /** Saves the plan the Project now runs and what each process's configuration held, so a restart or a failed upgrade can return to it. */
  const savePlan = (id: string, controller: PlanController, plan: Parameters<PlanController["reconcile"]>[0]) =>
    Effect.gen(function* () {
      const fingerprints = yield* controller.fingerprints;
      yield* writePlanState(paths(id).planState, { plan, configs: Object.fromEntries(fingerprints.map((entry) => [entry.name, entry.config])) });
    }).pipe(Effect.mapError(asRuntimeError));

  const urlOf = (parsed: RecipeManifest, state: RecipeState) => {
    const web = parsed.ports.find((port) => port.protocol === "http");
    return web ? `http://127.0.0.1:${state.ports[web.name]}` : undefined;
  };

  const capabilities = Object.freeze({
    independentRuntimeVersion: false, movable: false, liveMigration: false, secureIsolation: false, resourceLimits: false,
    persistentFilesystem: true, statelessRuntimeReplicas: false, managedStorage: true, managedDatabase: true,
    databaseReplication: false, tenantPlacement: false, databaseSharding: false,
    runtimeOwnership: "platform-process" as const,
    survivesControlPlaneRestart: agent.survivesControlPlaneRestart === true && typeof agent.attach === "function",
    zeroDowntimeUpdates: options.recipes !== undefined,
    description: options.description,
  });

  const stopProject = (id: string) => Effect.gen(function* () {
    const controller = controllers.get(id);
    if (controller) yield* controller.stop.pipe(Effect.mapError(asRuntimeError));
    yield* forget(id);
  });

  /** What the upgrade program needs from this driver. */
  const kit: UpgradeKitApi = {
    layout: (id: string) => { const where = paths(id); return { zelavis: where.zelavis, recipe: join(where.zelavis, "recipe"), descriptor: where.descriptor, planState: where.planState }; },
    recipeSource: (name: string, version: string) => options.recipes
      ? integration(() => options.recipes!.source(name, version)).pipe(Effect.mapError(() => new RecipeError({ operation: "upgrade", message: "The new recipe could not be located." })))
      : Effect.succeed(undefined),
    frozenDigest: (id: string) => options.recipes
      ? integration(() => options.recipes!.digest(join(paths(id).zelavis, "recipe", "package"))).pipe(Effect.mapError(() => new RecipeError({ operation: "upgrade", message: "The running recipe could not be verified." })))
      : Effect.fail(new RecipeError({ operation: "upgrade", message: "This host cannot verify the running recipe." })),
    stageArtifact: (source: string, data: string) => options.recipes
      ? integration(() => options.recipes!.stage(source, data)).pipe(Effect.mapError(() => new RecipeError({ operation: "upgrade", message: "The new recipe could not be frozen." })))
      : Effect.fail(new RecipeError({ operation: "upgrade", message: "This host cannot stage another version of the recipe." })),
    readManifest: (packageDirectory: string) => readManifest(packageDirectory).pipe(Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message }))),
    phase: (input: { id: string; name: RecipePhaseName; packageDirectory: string; timeoutMs: number }) => Effect.gen(function* () {
      const state = yield* readState(input.id);
      const candidate = yield* readManifest(input.packageDirectory);
      return yield* phase(input.id, input.name, state, candidate, input.timeoutMs, input.packageDirectory);
    }).pipe(Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message }))),
    controller: (id: string) => Effect.sync(() => controllers.get(id)),
    storedPlan: (id: string) => Effect.gen(function* () {
      const state = yield* readState(id).pipe(Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message })));
      return yield* readPlanState(paths(id).planState, allowedNames(id, state, yield* readManifest(options.packageDirectory).pipe(Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message })))));
    }),
    saveStoredPlan: (id: string, stored: Parameters<typeof writePlanState>[1]) => writePlanState(paths(id).planState, stored),
    writeDescriptor: (id: string, recipe: ZelavisProjectRecipeLock) => integration(() => readFile(paths(id).descriptor, "utf8")).pipe(
      Effect.flatMap((text) => evaluate(() => parseJson(text, preparedProjectRecord))),
      Effect.flatMap((descriptor) => integration(() => writeFile(paths(id).descriptor, `${JSON.stringify({ ...descriptor, recipe }, null, 2)}\n`, { mode: 0o600 }))),
      Effect.mapError(() => new RecipeError({ operation: "upgrade", message: "The Project's descriptor could not be updated." })),
    ),
    snapshot: (id: string) => Effect.gen(function* () {
      const [state, parsed] = [yield* readStateIfPresent(id), yield* manifest.pipe(Effect.option)];
      const url = state && parsed._tag === "Some" ? urlOf(parsed.value, state) : undefined;
      return { status: "running" as const, ...(url ? { url } : {}) };
    }),
    log: (id: string, message: string) => Effect.sync(() => log(id, "system", message)),
    markInstalled: (id: string, digest: string) => readState(id).pipe(
      Effect.flatMap((state) => writeState(id, { ...state, installedFor: digest })),
      Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message })),
    ),
  };
  const withKit = <A, E>(effect: Effect.Effect<A, E, UpgradeKit>) => effect.pipe(Effect.provideService(UpgradeKit, kit));

  const driver: EffectOperations<ZelavisProjectRuntimeDriver> = {
    name: options.name,
    runtimeKinds: Object.freeze(["native"]),
    defaultRuntimeKind: "native",
    startupConcurrency: 1,
    capabilities: () => capabilities,
    supportsLiveUpdate: (project) => options.recipes !== undefined && project.recipe.install !== undefined && controllers.has(project.id),

    prepare: Effect.fn("RecipeRuntime.prepare")(function* (project: ZelavisProjectRecord, recipe: ZelavisProjectRecipeLock) {
      const install = recipe.install;
      if (!install) return yield* Effect.fail(failure(`Project recipe "${recipe.name}" has no install lock; create the Project again.`));
      const parsed = yield* manifest;
      const method = parsed.methods.find((candidate) => candidate.id === install.method && candidate.driver === install.driver);
      if (!method || method.driver !== "js") return yield* Effect.fail(failure(`This runtime executes JavaScript install methods; "${install.method}" is not one.`));
      if (!parsed.software.some((candidate) => candidate.version === install.software)) {
        return yield* Effect.fail(failure(`The recipe does not offer software ${install.software}.`));
      }
      const owner = yield* account();
      const where = paths(project.id);
      const previous = yield* readStateIfPresent(project.id);
      const locations = { zelavis: where.zelavis, root: where.root, secrets: where.secrets };

      // A Project made by an earlier layout of this recipe is taken over by moving its folders
      // where this layout keeps them. Its files and database are not read or rewritten.
      let adopted: AdoptedValues | undefined;
      if (!previous) {
        const adoption = yield* detectAdoption(parsed.adopt, locations).pipe(Effect.mapError(asRuntimeError));
        if (adoption) {
          log(project.id, "system", "Taking over the Project's existing files.");
          adopted = yield* applyAdoption(adoption, locations).pipe(
            Effect.tapError(() => revertAdoption(locations).pipe(Effect.orElseSucceed(() => undefined))),
            Effect.mapError(asRuntimeError),
          );
        }
      }
      const undoAdoption = adopted
        ? Effect.gen(function* () {
            yield* revertAdoption(locations).pipe(Effect.mapError(asRuntimeError));
            yield* integration(() => rm(where.state, { force: true })).pipe(Effect.mapError(asRuntimeError));
          }).pipe(Effect.orElseSucceed(() => undefined))
        : Effect.void;

      yield* Effect.gen(function* () {
      const prepared = "The Project directories could not be prepared.";
      const make = (path: string) => integration(() => mkdir(path, { recursive: true, mode: 0o700 })).pipe(Effect.mapError(() => failure(prepared)));
      yield* make(where.root);
      yield* make(where.secrets);

      // Ports and socket identity are chosen once and kept, so a restart finds the same addresses.
      const ports: Record<string, number> = { ...previous?.ports, ...adopted?.ports };
      for (const port of parsed.ports) {
        if (ports[port.name] !== undefined) continue;
        let candidate = yield* availablePort();
        while (Object.values(ports).includes(candidate)) candidate = yield* availablePort();
        ports[port.name] = candidate;
      }
      const commands = yield* resolveRequirementCommands(method.requires).pipe(Effect.mapError(asRuntimeError));
      const sameInstall = previous?.method === install.method && previous.software === install.software;
      const state: RecipeState = {
        v: 1, ports, commands, method: install.method, software: install.software,
        socketId: previous?.socketId ?? adopted?.socketId ?? randomBytes(12).toString("hex"),
        installed: sameInstall && previous.installed,
        ...(sameInstall && previous.installedFor !== undefined ? { installedFor: previous.installedFor } : {}),
        // Data stays where the Project has it; a different path in this recipe is applied when it next starts from a stop.
        layout: Object.fromEntries((parsed.directories ?? []).map((directory) => [directory.name, previous?.layout?.[directory.name] ?? directory.path])),
      };
      yield* writeState(project.id, state);
      yield* make(socketDirectory(state));

      if (owner.uid !== undefined && owner.gid !== undefined) {
        const { uid, gid } = owner;
        for (const path of [where.project, socketDirectory(state)]) {
          yield* integration(() => chown(path, uid, gid)).pipe(Effect.mapError(() => failure(prepared)));
        }
        yield* ensureTraversable(dirname(where.project), owner);
      }

      if (!state.installed) {
        log(project.id, "system", `Installing ${recipe.name} ${install.software}.`);
        yield* phase(project.id, "install", state, parsed, options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
        yield* writeState(project.id, { ...state, installed: true, ...(recipe.artifact ? { installedFor: recipe.artifact.digest } : {}) });
        log(project.id, "system", "Installed.");
      }
      // Last, so a preparation that fails leaves the descriptor the earlier recipe wrote.
      // `project.json` is what the rest of the Platform reads to find this Project's recipe.
      yield* integration(() => writeFile(where.descriptor, `${JSON.stringify({ ...project, recipe, runtime: { driver: options.name, capabilities } }, null, 2)}\n`, { mode: 0o600 })).pipe(Effect.mapError(asRuntimeError));
      }).pipe(Effect.onError(() => undoAdoption));
    }),

    start: Effect.fn("RecipeRuntime.start")(function* (project: ZelavisProjectRecord, placement?: PlacementToken) {
      const parsed = yield* manifest;
      let state = yield* readState(project.id);
      if (!state.installed) return yield* Effect.fail(failure(`Project "${project.id}" is not installed; prepare it first.`));
      if (!controllers.has(project.id)) {
        // Nothing of the Project runs, so this is the moment its data can go where the recipe now wants it.
        const owner = yield* account();
        const relocation = yield* relocateDirectories({
          root: paths(project.id).root, layout: state.layout ?? {},
          directories: (parsed.directories ?? []).map((directory) => ({ name: directory.name, wanted: directory.path })),
          ...(owner.uid !== undefined && owner.gid !== undefined ? { owner: { uid: owner.uid, gid: owner.gid } } : {}),
        }).pipe(Effect.mapError(asRuntimeError));
        for (const name of relocation.moved) log(project.id, "system", `Moved "${name}" to ${relocation.layout[name]}.`);
        for (const { name, reason } of relocation.kept) log(project.id, "system", `"${name}" stays where it is: ${reason}.`);
        // A recipe upgraded while the Project was stopped has not prepared the app yet, and a moved directory
        // is named in the configuration its install phase wrote: prepare it again before anything starts.
        // Install is idempotent by contract.
        const locked = project.recipe.artifact?.digest;
        const stale = locked !== undefined && state.installedFor !== locked;
        if (JSON.stringify(relocation.layout) !== JSON.stringify(state.layout ?? {})) {
          state = { ...state, layout: relocation.layout };
          yield* writeState(project.id, state);
        }
        if (relocation.moved.length > 0 || stale) {
          log(project.id, "system", `Preparing the app for recipe ${project.recipe.version ?? locked ?? ""}.`);
          yield* phase(project.id, "install", state, parsed, options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
          state = { ...state, ...(locked !== undefined ? { installedFor: locked } : {}) };
          yield* writeState(project.id, state);
        }
      }
      // Running on the new layout means the upgrade was recorded: the way back can close.
      yield* commitAdoption({ zelavis: paths(project.id).zelavis, root: paths(project.id).root, secrets: paths(project.id).secrets }).pipe(Effect.mapError(asRuntimeError));
      const url = urlOf(parsed, state);
      const answer = () => ({ status: "running" as const, ...(url ? { url } : {}), startedAt: new Date().toISOString() });

      let controller = controllers.get(project.id);
      if (controller === undefined) {
        // Nothing of this Project is known to run, so any socket here is a leftover. One left in place
        // would pass a readiness check for a process that has not started.
        yield* integration(() => rm(socketDirectory(state), { recursive: true, force: true })).pipe(Effect.mapError(asRuntimeError));
        yield* integration(() => mkdir(socketDirectory(state), { recursive: true, mode: 0o700 })).pipe(Effect.mapError(asRuntimeError));
        const owner = yield* account();
        if (owner.uid !== undefined && owner.gid !== undefined) {
          const { uid, gid } = owner;
          yield* integration(() => chown(socketDirectory(state), uid, gid)).pipe(Effect.mapError(asRuntimeError));
        }
        controller = yield* createController(project.id, state, placement);
      }
      const result = yield* phase(project.id, "start", state, parsed, PHASE_TIMEOUT_MS);
      if (result.phase !== "start") return yield* Effect.fail(failure("The start phase returned no process plan."));
      // From nothing this starts the plan; with processes already running (adopted, or one that died)
      // it starts what is missing and leaves the rest alone.
      yield* controller.reconcile(result.plan).pipe(
        Effect.mapError(asRuntimeError),
        Effect.tapError(() => controller!.stop.pipe(Effect.andThen(forget(project.id)), Effect.orElseSucceed(() => undefined))),
      );
      yield* savePlan(project.id, controller, result.plan);
      return answer();
    }),

    stop: Effect.fn("RecipeRuntime.stop")(function* (projectId: string) {
      yield* stopProject(projectId);
      yield* clearPlanState(paths(projectId).planState).pipe(Effect.mapError(asRuntimeError));
      const state = yield* readStateIfPresent(projectId);
      if (state?.installed) {
        const parsed = yield* manifest;
        yield* phase(projectId, "stop", state, parsed, PHASE_TIMEOUT_MS);
      }
      return { status: "stopped" as const, stoppedAt: new Date().toISOString() };
    }),

    status: Effect.fn("RecipeRuntime.status")(function* (projectId: string) {
      const state = yield* readStateIfPresent(projectId);
      const controller = controllers.get(projectId);
      if (!state || !controller || !(yield* controller.running)) return { status: "stopped" as const };
      const url = urlOf(yield* manifest, state);
      return { status: "running" as const, ...(url ? { url } : {}) };
    }),

    logs: Effect.fn("RecipeRuntime.logs")(function* (projectId: string) { return [...(logs.get(projectId) ?? [])]; }),

    destroy: Effect.fn("RecipeRuntime.destroy")(function* (projectId: string) {
      yield* stopProject(projectId);
      const state = yield* readStateIfPresent(projectId);
      if (state?.installed) {
        yield* phase(projectId, "remove", state, yield* manifest, PHASE_TIMEOUT_MS);
      }
      if (state) yield* integration(() => rm(socketDirectory(state), { recursive: true, force: true })).pipe(Effect.mapError(asRuntimeError));
      yield* integration(() => rm(paths(projectId).project, { recursive: true, force: true })).pipe(Effect.mapError(asRuntimeError));
      logs.delete(projectId);
    }),

    commitUpgrade: Effect.fn("RecipeRuntime.commitUpgrade")(function* (projectId: string) {
      const where = paths(projectId);
      yield* commitAdoption({ zelavis: where.zelavis, root: where.root, secrets: where.secrets }).pipe(Effect.mapError(asRuntimeError));
    }),

    abandonUpgrade: Effect.fn("RecipeRuntime.abandonUpgrade")(function* (projectId: string) {
      const where = paths(projectId);
      const locations = { zelavis: where.zelavis, root: where.root, secrets: where.secrets };
      if (!(yield* adoptionPending(locations))) return;
      const state = yield* readStateIfPresent(projectId);
      yield* revertAdoption(locations).pipe(Effect.mapError(asRuntimeError));
      yield* integration(() => rm(where.state, { force: true })).pipe(Effect.mapError(asRuntimeError));
      if (state) yield* integration(() => rm(socketDirectory(state), { recursive: true, force: true })).pipe(Effect.mapError(asRuntimeError));
    }),

    prepareUpdate: Effect.fn("RecipeRuntime.prepareUpdate")(function* (previous: ZelavisProjectRecord, candidate: ZelavisProjectRecord) {
      return yield* withKit(prepareRecipeUpdate(previous, candidate)).pipe(Effect.mapError(asRuntimeError));
    }),

    applyUpdate: Effect.fn("RecipeRuntime.applyUpdate")(function* (
      projectId: string, update: ZelavisProjectRuntimeUpdate, commit: (selection: "previous" | "target") => Promise<void>,
    ) {
      return yield* withKit(applyRecipeUpdate(
        projectId, update,
        (choice) => integration(() => commit(choice)).pipe(Effect.mapError((error) => new RecipeError({ operation: "upgrade", message: error.message }))),
      )).pipe(Effect.mapError(asRuntimeError));
    }),

    settleUpdate: Effect.fn("RecipeRuntime.settleUpdate")(function* (projectId: string, _update: ZelavisProjectRuntimeUpdate, selection: "previous" | "target") {
      return yield* withKit(settleRecipeUpdate(projectId, selection)).pipe(Effect.mapError(asRuntimeError));
    }),

    recoverUpdate: Effect.fn("RecipeRuntime.recoverUpdate")(function* (projectId: string) {
      return yield* withKit(recoverRecipeUpdate(projectId)).pipe(Effect.mapError(asRuntimeError));
    }),

    close: Effect.fn("RecipeRuntime.close")(function* () {
      yield* Effect.forEach([...controllers.keys()], (id) => stopProject(id), { concurrency: 8, discard: true });
    }),

    adopt: Effect.fn("RecipeRuntime.adopt")(function* () {
      if (!agent.survivesControlPlaneRestart || !agent.attach) return;
      const entries = yield* integration(() => readdir(projectsDirectory, { withFileTypes: true }));
      if (entries.length > 4096) return yield* Effect.fail(failure("Recipe Project adoption exceeds its discovery bound."));
      const parsed = yield* manifest;
      yield* Effect.forEach(entries.filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(entry.name)), (entry) => Effect.gen(function* () {
        const id = entry.name;
        const state = yield* readStateIfPresent(id);
        if (!state?.installed || controllers.has(id)) return;
        const attached = yield* integration(() => agent.attach!(id));
        if (attached.length === 0) return;
        // What the processes were started from was saved; asking the recipe again is the fallback.
        const saved = yield* readPlanState(paths(id).planState, allowedNames(id, state, parsed)).pipe(Effect.mapError(asRuntimeError));
        let plan = saved?.plan;
        if (!plan) {
          const result = yield* phase(id, "start", state, parsed, PHASE_TIMEOUT_MS);
          if (result.phase !== "start") return yield* Effect.fail(failure("The start phase returned no process plan."));
          plan = result.plan;
        }
        const controller = yield* createController(id, state);
        yield* controller.adopt(plan, attached, saved?.configs ?? {}).pipe(Effect.mapError(asRuntimeError));
      }), { concurrency: 4, discard: true });
    }),
  };
  return defineEffectProjectRuntime(driver as never);
}
