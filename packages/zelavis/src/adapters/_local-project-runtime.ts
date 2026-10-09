import { isUnknown, optional, objectFields, parseJson } from "../core/json-validation.js";
import { unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { provideHostPackagesTo } from "./_service-resolution.js";
import { defineEffectProjectRuntime, type ZelavisRecipeRuntimeContext } from "./project-runtime.js";
import { Deferred, Effect } from "effect";
import { evaluate, integration, present, effectOperations, singleFlight, type EffectOperations } from "../core/runtime/effect-boundary.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZelavisProjectDescriptor, ZelavisProjectRecipeLock, ZelavisProjectRuntimeDriver } from "../project.js";
import { manifestProjectRecipe, validatePluginPackageManifest, type ZelavisProjectRecipeDefinition } from "../service.js";
import { ZelavisProjectRuntimeError } from "../project.js";
import { createNodeProcessProjectRuntime, type NodeProcessProjectRuntimeOptions, } from "./_node-project-runtime.js";
import { createServerFrontendProjectRuntime, type ServerFrontendProjectRuntimeOptions, } from "./_server-frontend-project-runtime.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type { ZelavisAgentAttachedProcess, ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import { resolveBundledServiceDirectory, linkPlatformPackage } from "./_local-runtime.js";
import { RECIPE_ARTIFACT_DIRECTORY, digestArtifactDirectory, materializeRecipeArtifact, } from "./_recipe-artifact.js";
import { prepareManagedRecipeUpdate } from "./_managed-recipe-update.js";
import { restoreNodeProjectRelease } from "./_node-project-release.js";
/**
 * Where a recipe that provides its own runtime comes from, and whether this host
 * lets it.
 */
export interface RecipeRuntimeSources {
    /** Where an installed or checked-out recipe package lies. Bundled ones are found without it. */
    packageDirectory?(name: string, version?: string): Promise<string | undefined> | string | undefined;
    /**
     * Whether a recipe may provide the runtime its Projects run under. A recipe
     * runtime is host code with the Platform's authority, so this is a decision
     * the host makes, never something a package claims for itself.
     */
    trusted(name: string): Promise<boolean> | boolean;
}
export interface LocalProjectRuntimeOptions extends NodeProcessProjectRuntimeOptions {
    /**
     * Runs `server` frontends. Omit it and a frontend Project cannot start,
     * rather than silently falling through to the Zelavis runner and failing in
     * a way that looks like a broken frontend.
     */
    serverFrontend?: Omit<ServerFrontendProjectRuntimeOptions, "directory">;
    /**
     * Recipes that provide their own runtime (their `package.json` declares
     * `zelavis.project.runtime`). Without it no recipe can, and a Project of one
     * fails to prepare with that reason.
     */
    recipeRuntimes?: RecipeRuntimeSources;
    /** Options for a recipe's runtime, by recipe name. */
    recipeRuntimeOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    /**
     * Agent that executes every Project process on this host.
     *
     * Defaults to running them in this process. Point it at a separately
     * supervised Agent and the drivers are unchanged — that is what putting them
     * behind the contract bought.
     */
    agent?: ZelavisAgentProcessRunner;
}
/** Project kind used for a Project-owned server frontend. */
const SERVER_FRONTEND_KIND = "frontend";
function frozenRecipeDirectory(projectsDirectory: string, projectId: string): string {
    return join(projectsDirectory, projectId, ".zelavis", RECIPE_ARTIFACT_DIRECTORY, "package");
}
const declaredRuntimeEntry = Effect.fn("LocalProjects.declaredRuntimeEntry")(function* (packageDirectory: string): Effect.fn.Return<string | undefined, TaggedFailure> {
    const text = yield* Effect.catch(integration(() => readFile(join(packageDirectory, "package.json"), "utf8")), Effect.fn("LocalProjects.recover")(function* () { return undefined; }));
    if (!text)
        return undefined;
    const manifest = yield* integration(() => parseJson(text, objectFields<{ zelavis?: { project?: { runtime?: unknown } } }>({zelavis: optional(objectFields<{ project?: { runtime?: unknown } }>({project: optional(objectFields<{ runtime?: unknown }>({runtime: optional(isUnknown)}))}))}))).pipe(Effect.orElseSucceed(() => undefined));
    if (!manifest)
        return undefined;
    const entry = manifest.zelavis?.project?.runtime;
    if (entry === undefined)
        return undefined;
    if (typeof entry !== "string" || !entry.startsWith("./") || entry.split("/").includes("..")) {
        return yield* Effect.fail(new ZelavisProjectRuntimeError("A recipe's zelavis.project.runtime must be a path inside its own package, such as ./dist/runtime.js."));
    }
    return entry;
});
/** Routes Project recipes to native drivers while preserving one Platform lifecycle boundary. */
export function createLocalProjectRuntime(options: LocalProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
    const directory = resolve(options.directory);
    // One Agent for every driver rather than one each. They share a host, so
    // they share the record of what is running on it — separate runners would
    // each sweep only their own leftovers, and a Project that changed recipe
    // would leave one behind that nothing owns. It is also the single place to
    // swap in an Agent that runs elsewhere.
    const agent = options.agent ??
        createLocalAgentProcessRunner({
            stateDirectory: join(directory, ".agent-processes"),
        });
    // Share placement and execution authority, but adopt only the processes
    // belonging to each supervisor. The Agent withholds environment secrets.
    // Agent attachment transfers custody once. Claim each workload once per
    // adoption pass, then give each supervisor its own view of that inventory.
    let adoptionInventory: Map<string, Deferred.Deferred<readonly ZelavisAgentAttachedProcess[], TaggedFailure>> | undefined;
    const agentView = (integrationHost: boolean): ZelavisAgentProcessRunner => ({ ...agent,
        ...(agent.attach ? { attach: (id: string) => present((adoptionInventory
            ? singleFlight(adoptionInventory, id, () => integration(() => agent.attach!(id)), true)
            : integration(() => agent.attach!(id))).pipe(
            Effect.map(attached => attached.filter(({ command }) => (command.args?.includes("--integration") === true) === integrationHost)),
        )) } : {}),
    });
    const recipeAgent = agentView(false);
    const node = createNodeProcessProjectRuntime({ ...options, agent: recipeAgent });
    const integrationNode = createNodeProcessProjectRuntime({ ...options, integrationOnly: true, agent: agentView(true),
        recipePackageDirectory: (name, version) => present(Effect.gen(function* () {
            return (yield* integration(() => options.recipeRuntimes?.packageDirectory?.(name, version))) ??
                (yield* integration(() => options.recipePackageDirectory?.(name, version))) ?? resolveBundledServiceDirectory(name);
        })),
    });
    const integrationRuntime = effectOperations(integrationNode);
    const serverFrontend = options.serverFrontend
        ? createServerFrontendProjectRuntime({
            directory,
            ...options.serverFrontend,
            agent,
        })
        : undefined;
    // Recipe runtimes are loaded from the copy frozen inside each Project and
    // shared by every Project frozen to the same digest.
    const recipeDrivers = new Map<string, ZelavisProjectRuntimeDriver>();
    const driverOfProject = new Map<string, ZelavisProjectRuntimeDriver>();
    const verified = new Map<string, { name: string; version: string; definition: ZelavisProjectRecipeDefinition }>();
    const recipeDefinitions = new Map<string, { name: string; version: string; digest: string; definition: ZelavisProjectRecipeDefinition }>();
    const adoptionFailures = new Map<ZelavisProjectRuntimeDriver, string>();
    const selectFrontend = (): ZelavisProjectRuntimeDriver => {
        if (!serverFrontend) {
            throw new ZelavisProjectRuntimeError("This host is not configured to run server frontends.");
        }
        return serverFrontend;
    };
    const assertNative = (runtimeKind: unknown) => {
        // An absent kind is refused like a foreign one: this driver executes only
        // an explicit native assignment and never infers one.
        if (runtimeKind !== "native") {
            throw new ZelavisProjectRuntimeError(runtimeKind === undefined
                ? "The local Project runtime requires an explicit native runtime kind."
                : `The local Project runtime cannot execute the "${String(runtimeKind)}" runtime kind.`);
        }
    };
    const assertTrusted = Effect.fn("LocalProjects.assertTrusted")(function* (name: string): Effect.fn.Return<void, TaggedFailure> {
        if (!((yield* integration(() => options.recipeRuntimes?.trusted(name))))) {
            return yield* Effect.fail(new ZelavisProjectRuntimeError(`Project recipe "${name}" provides its own runtime, and this host has not enabled that. ` +
                "Only recipes an operator trusts (for example an allow-listed official one) may."));
        }
    });
    const loadRecipeDriver = Effect.fn("LocalProjects.loadRecipeDriver")(function* (projectId: string, recipe: Pick<ZelavisProjectRecipeLock, "name"> & {
        version?: string;
    }, digest: string, entry: string, retainSupervisor = false): Effect.fn.Return<ZelavisProjectRuntimeDriver, TaggedFailure> {
        yield* assertTrusted(recipe.name);
        const frozen = frozenRecipeDirectory(directory, projectId);
        const manifest = yield* Effect.flatMap(integration(() => readFile(join(frozen, "package.json"), "utf8")), value => evaluate(() => JSON.parse(value)));
        if (manifest.name !== recipe.name || recipe.version && manifest.version !== recipe.version) {
            return yield* Effect.fail(new ZelavisProjectRuntimeError(`Project recipe artifact does not match its locked name and version.`));
        }
        const key = `${projectId}:${digest}`;
        if (!verified.has(key)) {
            if ((yield* integration(() => digestArtifactDirectory(frozen))) !== digest)
                return yield* Effect.fail(new ZelavisProjectRuntimeError(`Project recipe "${recipe.name}" does not match its locked digest; refusing to run modified code.`));
            const definition = yield* evaluate(() => manifestProjectRecipe(validatePluginPackageManifest(manifest)));
            if (!definition) return yield* Effect.fail(new ZelavisProjectRuntimeError("A custom runtime requires a Project recipe definition."));
            verified.set(key, { name: manifest.name, version: manifest.version, definition });
        }
        // Reuse only the definition read when this exact digest was verified.
        recipeDefinitions.set(projectId, { ...verified.get(key)!, digest });
        // Recipe integration refreshes never replace a live app's supervisor.
        // Its next ordinary prepare, or Agent adoption by a new Platform engine,
        // loads the selected recipe implementation after verifying this lock.
        const active = driverOfProject.get(projectId);
        if (retainSupervisor && active) return active;
        const cached = recipeDrivers.get(digest);
        if (cached) {
            driverOfProject.set(projectId, cached);
            return cached;
        }
        // ESM caches relative imports by file URL. A version query on the entry
        // alone leaves its dependencies cached, so each digest needs its own path.
        const modules = join(directory, projectId, ".zelavis", "recipe-modules", digest.replace(":", "-"));
        const modulePackage = join(modules, RECIPE_ARTIFACT_DIRECTORY, "package");
        if (!existsSync(modulePackage))
            yield* integration(() => materializeRecipeArtifact(frozen, modules));
        if ((yield* integration(() => digestArtifactDirectory(modulePackage))) !== digest) {
            return yield* Effect.fail(new ZelavisProjectRuntimeError("Recipe module copy does not match its locked digest."));
        }
        // Lets the frozen package resolve `zelavis/*` against the Platform running it.
        yield* integration(() => linkPlatformPackage(join(modules, RECIPE_ARTIFACT_DIRECTORY)));
        provideHostPackagesTo(modulePackage);
        const module = ((yield* integration(() => import(pathToFileURL(join(modulePackage, entry)).href)))) as {
            createProjectRuntime?: (context: ZelavisRecipeRuntimeContext) => ZelavisProjectRuntimeDriver;
        };
        if (typeof module.createProjectRuntime !== "function") {
            return yield* Effect.fail(new ZelavisProjectRuntimeError(`Project recipe "${recipe.name}" declares a runtime but does not export createProjectRuntime.`));
        }
        const driver = module.createProjectRuntime({
            directory,
            packageDirectory: modulePackage,
            agent: recipeAgent,
            recipes: {
                // The exact version asked for, from where this host keeps recipes, or nothing.
                source: (name, version) => present(Effect.gen(function* () {
                    const found = (yield* integration(() => options.recipeRuntimes?.packageDirectory?.(name, version))) ??
                        (yield* integration(() => options.recipePackageDirectory?.(name, version))) ?? resolveBundledServiceDirectory(name);
                    if (!found) return undefined;
                    const identity = yield* Effect.flatMap(integration(() => readFile(join(found, "package.json"), "utf8")), value => evaluate(() => parseJson(value, objectFields<{ name?: unknown; version?: unknown }>({ name: isUnknown, version: isUnknown }), "recipe package.json")));
                    return identity.name === name && identity.version === version ? found : undefined;
                })),
                stage: (source, dataDirectory) => materializeRecipeArtifact(source, dataDirectory),
                digest: (packageDirectory) => digestArtifactDirectory(packageDirectory),
            },
            options: options.recipeRuntimeOptions?.[recipe.name] ?? {},
        });
        recipeDrivers.set(digest, driver);
        driverOfProject.set(projectId, driver);
        return driver;
    });
    const recipeDriver = Effect.fn("LocalProjects.recipeDriver")(function* (projectId: string, recipe: Pick<ZelavisProjectRecipeLock, "name"> & {
        version?: string;
        artifact?: {
            digest: string;
        };
    }, mode: "prepare" | "use"): Effect.fn.Return<{
        driver: ZelavisProjectRuntimeDriver;
        digest: string;
    } | undefined, TaggedFailure> {
        const frozen = frozenRecipeDirectory(directory, projectId);
        if (existsSync(frozen)) {
            const manifest = yield* Effect.flatMap(integration(() => readFile(join(frozen, "package.json"), "utf8")), value => evaluate(() => JSON.parse(value)));
            if (mode === "use" || manifest.name === recipe.name && (!recipe.version || manifest.version === recipe.version)) {
                const entry = yield* declaredRuntimeEntry(frozen);
                if (!entry)
                    return undefined;
                const digest = recipe.artifact?.digest ?? ((yield* integration(() => digestArtifactDirectory(frozen))));
                return { driver: (yield* loadRecipeDriver(projectId, recipe, digest, entry, mode === "use")), digest };
            }
        }
        if (mode === "use")
            return undefined;
        let source = ((yield* integration(() => options.recipeRuntimes?.packageDirectory?.(recipe.name)))) ??
            resolveBundledServiceDirectory(recipe.name);
        // Recipes without a custom runtime belong to the native Zelavis runner,
        // which owns freezing and its explicit unavailable-version/upgrade refusal.
        if (source && !((yield* declaredRuntimeEntry(source))))
            return undefined;
        if (source && recipe.version) {
            const manifest = yield* Effect.flatMap(integration(() => readFile(join(source!, "package.json"), "utf8")), value => evaluate(() => JSON.parse(value)));
            if (manifest.name !== recipe.name || manifest.version !== recipe.version)
                source = undefined;
        }
        source ??= recipe.version ? (yield* integration(() => options.recipePackageDirectory?.(recipe.name, recipe.version))) : undefined;
        if (!source)
            return undefined;
        const manifest = yield* Effect.flatMap(integration(() => readFile(join(source!, "package.json"), "utf8")), value => evaluate(() => JSON.parse(value)));
        if (manifest.name !== recipe.name || recipe.version && manifest.version !== recipe.version) {
            return yield* Effect.fail(new ZelavisProjectRuntimeError("Project recipe source does not match its locked name and version."));
        }
        const entry = yield* declaredRuntimeEntry(source);
        if (!entry)
            return undefined;
        yield* assertTrusted(recipe.name);
        const { digest } = yield* integration(() => materializeRecipeArtifact(source, join(directory, projectId, ".zelavis")));
        return { driver: (yield* loadRecipeDriver(projectId, recipe, digest, entry)), digest };
    });
    const forDescriptor = (project: Readonly<ZelavisProjectDescriptor>) => {
        assertNative(project.runtimeKind);
        if (project.kind === SERVER_FRONTEND_KIND)
            return selectFrontend();
        // Loaded by an earlier prepare or by `adopt`; until then the Zelavis
        // runner's description stands in for it.
        return driverOfProject.get(project.id) ?? node;
    };
    const forProjectId = Effect.fn("LocalProjects.step")(function* (projectId: string) {
        const record = (yield* Effect.flatMap(integration(() => readFile(join(directory, projectId, "project.json"), "utf8")), value => evaluate(() => JSON.parse(value)))) as {
            recipe?: {
                name?: unknown;
                version?: unknown;
                managed?: unknown;
                artifact?: {
                    digest?: unknown;
                };
            };
            kind?: unknown;
            runtimeKind?: unknown;
        };
        yield* evaluate(() => assertNative(record.runtimeKind));
        if (record.kind === SERVER_FRONTEND_KIND)
            return selectFrontend();
        const name = record.recipe?.name;
        if (typeof name === "string") {
            const digest = record.recipe?.artifact?.digest;
            const chosen = yield* recipeDriver(projectId, { name, ...(typeof record.recipe?.version === "string" ? { version: record.recipe.version } : {}), ...(typeof digest === "string" ? { artifact: { digest } } : {}) }, "use");
            if (chosen)
                return chosen.driver;
        }
        return node;
    });
    const missingDescriptor = (error: unknown, id: string) => {
        error = unwrapFailure(error);
        return error instanceof Error && "code" in error && error.code === "ENOENT" && "path" in error && error.path === join(directory, id, "project.json");
    };
    const stopProject = Effect.fn("LocalProjects.stopProject")(function* (id: string) {
        yield* integrationRuntime.stop(id);
        return yield* Effect.catch(Effect.gen(function* () { const selected = yield* forProjectId(id); return yield* effectOperations(selected).stop(id); }), Effect.fn("LocalProjects.recover")(function* (error) {
            if (!missingDescriptor(error, id))
                return yield* Effect.fail(error);
            const known = driverOfProject.get(id);
            if (known)
                return (yield* effectOperations(known).stop(id));
            // Preparation can fail before project.json exists. Stop only this exact
            // native workload through the Agent, without importing an unknown recipe.
            for (const attached of (yield* integration(() => agent.attach?.(id))) ?? []) {
                if (attached.process.workloadId !== id)
                    return (yield* Effect.fail(new ZelavisProjectRuntimeError("Agent returned another Project's process.")));
                (yield* integration(() => attached.process.stop()));
            }
            if (agent.survivesControlPlaneRestart && !agent.attach) {
                return (yield* Effect.fail(new ZelavisProjectRuntimeError("Cannot confirm this Project stopped: its Agent does not support reattachment.")));
            }
            (yield* integration(() => agent.reclaim?.(id)));
            return (yield* effectOperations(node).stop(id));
        }));
    });
    const loaded = () => [...new Set([...recipeDrivers.values()])];
    const recipeDefinition = (project: Readonly<ZelavisProjectDescriptor>) => {
        const selected = recipeDefinitions.get(project.id);
        return selected?.name === project.recipe.name && selected.version === project.recipe.version &&
            (!project.recipe.artifact || selected.digest === project.recipe.artifact.digest) ? selected.definition : undefined;
    };
    const managedIntegration = (project: Readonly<ZelavisProjectDescriptor>) =>
        !!recipeDefinition(project)?.managed && forDescriptor(project) !== node && forDescriptor(project) !== serverFrontend;
    /** The recipe's own runtime, when it can upgrade the processes it supervises without stopping them. */
    const workloadOf = (project: Readonly<ZelavisProjectDescriptor>) => {
        const selected = forDescriptor(project);
        if (selected === node || selected === serverFrontend) return undefined;
        const operations = effectOperations(selected);
        return selected.supportsLiveUpdate?.(project) === true && operations.prepareUpdate && operations.applyUpdate && operations.settleUpdate ? operations : undefined;
    };
    const driver: EffectOperations<ZelavisProjectRuntimeDriver> = {
        name: "local-project",
        detach: Effect.fn("LocalProjects.detach")(function* () {
            if (!agent.survivesControlPlaneRestart || !agent.attach) return yield* Effect.fail(new ZelavisProjectRuntimeError("This Agent cannot retain Project custody."));
            yield* integration(() => agent.close());
        }),
        adopt: Effect.fn("LocalProjects.adopt")(function* () {
            adoptionInventory = new Map();
            yield* Effect.gen(function* () {
                yield* Effect.catch(Effect.gen(function* () {
                    for (const entry of (yield* integration(() => readdir(directory, { withFileTypes: true })))) {
                        if (!entry.isDirectory() || entry.name.startsWith("."))
                            continue;
                        (yield* Effect.catch(Effect.gen(function* () {
                            (yield* forProjectId(entry.name));
                        }), Effect.fn("LocalProjects.recover")(function* (_error) {
                        })));
                    }
                }), Effect.fn("LocalProjects.recover")(function* (_error) {
                }));
                // Each driver knows which of its own Projects the Agent still runs; the
                // router only has to ask all of them.
                for (const driver of [node, integrationNode, ...loaded(), serverFrontend]) {
                    if (driver) yield* (effectOperations(driver).adopt?.() ?? Effect.void).pipe(
                        Effect.tap(() => Effect.sync(() => adoptionFailures.delete(driver))),
                        Effect.catch(error => Effect.sync(() => { adoptionFailures.set(driver, String(unwrapFailure(error)).slice(0, 4000)); })),
                    );
                }
            }).pipe(Effect.ensuring(Effect.sync(() => { adoptionInventory = undefined; })));
        }),
        runtimeKinds: Object.freeze(["native"]),
        defaultRuntimeKind: "native",
        startupConcurrency: 1,
        recipeDefinition,
        capabilities: (project) => ({ ...forDescriptor(project).capabilities(project),
            ...(managedIntegration(project) ? { zeroDowntimeUpdates: true, recipeUpdateMode: "integration" as const } : {}) }),
        supportsLiveUpdate: project => managedIntegration(project) || forDescriptor(project).supportsLiveUpdate?.(project) === true,
        versions: Effect.fn("LocalProjects.versions")(function* (project) {
            if (project && forDescriptor(project) !== node) return { selectable: false, reason: "This recipe manages its own runtime version.", versions: [] };
            return yield* effectOperations(node).versions!(project);
        }),
        resolveVersion: Effect.fn("LocalProjects.resolveVersion")(function* (project, version) {
            return yield* effectOperations(node).resolveVersion!(project, version);
        }),
        prepareUpdate: Effect.fn("LocalProjects.prepareUpdate")(function* (previous, candidate, placement) {
            if (managedIntegration(previous)) {
                yield* assertTrusted(candidate.recipe.name);
                const source = (yield* integration(() => options.recipeRuntimes?.packageDirectory?.(candidate.recipe.name, candidate.recipe.version))) ??
                    (yield* integration(() => options.recipePackageDirectory?.(candidate.recipe.name, candidate.recipe.version))) ??
                    resolveBundledServiceDirectory(candidate.recipe.name);
                if (!source) return yield* Effect.fail(new ZelavisProjectRuntimeError("Managed recipe source is unavailable."));
                if (previous.runtime.status === "running") {
                    yield* integrationRuntime.start(previous, placement);
                    const refreshed = yield* integrationRuntime.prepareUpdate!(previous, candidate, placement);
                    // A recipe that supervises the app's own processes moves them in the same transaction.
                    const workload = workloadOf(previous);
                    if (!workload) return refreshed;
                    const staged = yield* workload.prepareUpdate!(previous, candidate, placement);
                    if (staged.target.digest !== refreshed.recipe.artifact?.digest) {
                        yield* workload.settleUpdate!(previous.id, staged, "previous");
                        return yield* Effect.fail(new ZelavisProjectRuntimeError("The workload and integration updates froze different recipes."));
                    }
                    return { ...refreshed, workload: { ...staged, host: true as const } };
                }
                return yield* prepareManagedRecipeUpdate(join(directory, previous.id), previous, candidate, source);
            }
            const selected = effectOperations(forDescriptor(previous));
            if (!selected.prepareUpdate) return yield* Effect.fail(new ZelavisProjectRuntimeError("This recipe runtime does not support live updates."));
            return yield* selected.prepareUpdate(previous, candidate, placement);
        }),
        applyUpdate: Effect.fn("LocalProjects.applyUpdate")(function* (id, update, commit) {
            if (update.mode === "integration") {
                const selected = effectOperations(yield* forProjectId(id));
                if (update.host && update.workload) {
                    if (!selected.applyUpdate) return yield* Effect.fail(new ZelavisProjectRuntimeError("This recipe runtime cannot upgrade its processes in place."));
                    const { workload: _staged, ...refresh } = update;
                    // The processes are reconciled first and can be put back; the host's handover is the commit.
                    yield* selected.applyUpdate(id, update.workload, choice => choice === "target"
                        ? present(integrationRuntime.applyUpdate!(id, refresh, commit).pipe(Effect.asVoid))
                        : Promise.resolve());
                    yield* forProjectId(id);
                    return yield* selected.status(id);
                }
                if (update.host) {
                    yield* integrationRuntime.applyUpdate!(id, update, commit);
                    yield* forProjectId(id);
                    return yield* selected.status(id);
                }
                return yield* Effect.uninterruptible(Effect.gen(function* () {
                    yield* restoreNodeProjectRelease(join(directory, id), id, update.target);
                    yield* integration(() => commit("target"));
                    yield* forProjectId(id);
                    return yield* selected.status(id);
                }).pipe(Effect.onError(() => Effect.gen(function* () {
                    yield* restoreNodeProjectRelease(join(directory, id), id, update.previous);
                    yield* forProjectId(id);
                    yield* integration(() => commit("previous"));
                }).pipe(Effect.orDie))));
            }
            const selected = effectOperations(yield* forProjectId(id));
            if (!selected.applyUpdate) return yield* Effect.fail(new ZelavisProjectRuntimeError("This recipe runtime does not support live updates."));
            return yield* selected.applyUpdate(id, update, commit);
        }),
        recoverUpdate: Effect.fn("LocalProjects.recoverUpdate")(function* (id, update) {
            if (update.mode === "integration") {
                if (update.host) {
                    const { workload: staged, ...refresh } = update;
                    const selection = yield* integrationRuntime.recoverUpdate!(id, refresh);
                    yield* forProjectId(id);
                    // The host's journal proved which recipe is the Project's; the processes follow it.
                    if (staged) yield* (effectOperations(yield* forProjectId(id)).settleUpdate?.(id, staged, selection) ?? Effect.fail(new ZelavisProjectRuntimeError("This recipe runtime cannot settle an interrupted upgrade.")));
                    return selection;
                }
                // The durable intent is cleared only after the complete commit.
                // An interrupted integration transaction rolls back its code and
                // metadata; the app's software and processes were never changed.
                yield* restoreNodeProjectRelease(join(directory, id), id, update.previous);
                yield* (effectOperations(yield* forProjectId(id)).adopt?.() ?? Effect.void);
                return "previous" as const;
            }
            const selected = effectOperations(yield* forProjectId(id));
            if (!selected.recoverUpdate) return yield* Effect.fail(new ZelavisProjectRuntimeError("This recipe runtime cannot recover a live update."));
            return yield* selected.recoverUpdate(id, update);
        }),
        prepare: Effect.fn("LocalProjects.prepare")(function* (project: Parameters<NonNullable<ZelavisProjectRuntimeDriver["prepare"]>>[0], recipe: Parameters<NonNullable<ZelavisProjectRuntimeDriver["prepare"]>>[1]) {
            yield* evaluate(() => assertNative(project.runtimeKind));
            if (project.kind === SERVER_FRONTEND_KIND)
                return yield* effectOperations(selectFrontend()).prepare(project, recipe);
            const data = join(directory, project.id, ".zelavis");
            const frozen = join(data, RECIPE_ARTIFACT_DIRECTORY);
            let changing = false;
            if (existsSync(join(frozen, "package", "package.json"))) {
                const manifest = yield* Effect.flatMap(integration(() => readFile(join(frozen, "package", "package.json"), "utf8")), value => evaluate(() => JSON.parse(value)));
                changing = manifest.name !== recipe.name || manifest.version !== recipe.version;
            }
            const previousDriver = driverOfProject.get(project.id);
            const previousDefinition = recipeDefinitions.get(project.id);
            const backup = join(data, `recipe-backup-${crypto.randomUUID()}`);
            let descriptor: Buffer | undefined;
            if (changing) {
                yield* Effect.catch(Effect.gen(function* () { descriptor = (yield* integration(() => readFile(join(directory, project.id, "project.json")))); }), Effect.fn("LocalProjects.recover")(function* (error) { if (!missingDescriptor(error, project.id))
                    return (yield* error); }));
                yield* integration(() => mkdir(backup, { recursive: true, mode: 0o700 }));
                yield* Effect.catch(Effect.gen(function* () { (yield* integration(() => cp(frozen, join(backup, "recipe"), { recursive: true }))); }), Effect.fn("LocalProjects.recover")(function* (error) {
                    (yield* integration(() => rm(backup, { recursive: true, force: true })));
                    return (yield* error);
                }));
            }
            let discardBackup = true;
            yield * Effect.gen(function* () {
                const provided = yield* recipeDriver(project.id, recipe, "prepare");
                if (provided) {
                    const lockedRecipe = { ...recipe, artifact: { digest: provided.digest } };
                    yield* integration(() => writeFile(join(directory, project.id, "project.json"), JSON.stringify({ ...project, recipe: lockedRecipe }), { mode: 0o600 }));
                    yield* effectOperations(provided.driver).prepare(project, lockedRecipe);
                }
                else {
                    driverOfProject.delete(project.id);
                    yield* effectOperations(node).prepare(project, recipe);
                }
            }).pipe(Effect.onError(() => Effect.gen(function* () {
                if (changing) {
                    discardBackup = false;
                    yield* integration(() => rm(frozen, { recursive: true, force: true }));
                    yield* integration(() => cp(join(backup, "recipe"), frozen, { recursive: true }));
                    if (descriptor)
                        yield* integration(() => writeFile(join(directory, project.id, "project.json"), descriptor!, { mode: 0o600 }));
                    else
                        yield* integration(() => rm(join(directory, project.id, "project.json"), { force: true }));
                    if (previousDriver)
                        driverOfProject.set(project.id, previousDriver);
                    else
                        driverOfProject.delete(project.id);
                    if (previousDefinition) recipeDefinitions.set(project.id, previousDefinition);
                    else recipeDefinitions.delete(project.id);
                    discardBackup = true;
                }
            }).pipe(Effect.orDie)), Effect.ensuring(Effect.suspend(() => changing && discardBackup
                ? integration(() => rm(backup, { recursive: true, force: true })).pipe(Effect.orDie)
                : Effect.void)));
        }),
        start: Effect.fn("LocalProjects.start")(function* (project, placement) {
            const selected = yield* forProjectId(project.id);
            return yield* effectOperations(selected).start(project, placement);
        }),
        ...(agent.fencePlacement ? {
            fencePrevious: (placement: Parameters<NonNullable<ZelavisProjectRuntimeDriver["fencePrevious"]>>[0]) => integration(() => agent.fencePlacement!(placement)),
        } : {}),
        stop: stopProject,
        status: Effect.fn("LocalProjects.status")(function* (id) {
            return yield* Effect.gen(function* () {
                const selected = yield* forProjectId(id);
                const state = yield* effectOperations(selected).status(id);
                const error = adoptionFailures.get(selected);
                return error && state.status !== "running" ? { status: "failed" as const, error } : state;
            }).pipe(Effect.orElseSucceed(error => ({ status: "failed" as const, error: String(unwrapFailure(error)).slice(0, 4000) })));
        }),
        logs: Effect.fn("LocalProjects.logs")(function* (id) {
            const selected = yield* forProjectId(id);
            return yield* effectOperations(selected).logs(id);
        }),
        destroy: Effect.fn("LocalProjects.step")(function* (id) {
            let selected: ZelavisProjectRuntimeDriver;
            yield* Effect.catch(Effect.gen(function* () { selected = (yield* forProjectId(id)); }), Effect.fn("LocalProjects.recover")(function* (error) {
                if (!missingDescriptor(error, id))
                    return yield* Effect.fail(error);
                (yield* stopProject(id));
                selected = driverOfProject.get(id) ?? node;
            }));
            yield* integrationRuntime.stop(id);
            yield* effectOperations(selected!).destroy(id);
            yield* integrationRuntime.destroy(id);
            driverOfProject.delete(id);
            recipeDefinitions.delete(id);
        }),
        commitUpgrade: Effect.fn("LocalProjects.commitUpgrade")(function* (id) {
            const selected = effectOperations(yield* forProjectId(id));
            if (selected.commitUpgrade) yield* selected.commitUpgrade(id);
        }),
        abandonUpgrade: Effect.fn("LocalProjects.abandonUpgrade")(function* (id) {
            const selected = effectOperations(yield* forProjectId(id));
            if (selected.abandonUpgrade) yield* selected.abandonUpgrade(id);
        }),
        close: Effect.fn("LocalProjects.step")(function* () {
            yield* Effect.forEach([node, integrationNode, ...loaded(), ...serverFrontend ? [serverFrontend] : []], driver => effectOperations(driver).close(), { concurrency: 8, discard: true });
        }),
        gatewayTarget: Effect.fn("LocalProjects.gatewayTarget")(function* (project, placement) {
            yield* forProjectId(project.id);
            return managedIntegration(project) ? (yield* integrationRuntime.start(project, placement)).url : project.runtime.url;
        }),
        signGatewayAuthority: Effect.fn("LocalProjects.step")(function* (id, claims) {
            const selected = driverOfProject.get(id) ?? (yield* forProjectId(id));
            const sign = effectOperations(recipeDefinitions.get(id)?.definition.managed ? integrationNode : selected).signGatewayAuthority;
            if (!sign) return undefined;
            return yield* sign(id, claims);
        }),
    };
    return defineEffectProjectRuntime(driver);
}
