import { IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { defineEffectProjectRuntime } from "./project-runtime.js";
import { Cause, Deferred, Effect } from "effect";
import { integration, singleFlight, type EffectOperations } from "../core/runtime/effect-boundary.js";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRecipeArtifact } from "./_recipe-artifact.js";
import { ZELAVIS_VERSION } from "../version.js";
import { describeInstallation } from "../cli/installation.js";
import { createNodeRuntimeCatalog } from "./_node-runtime-catalog.js";
import { freezeNodeProjectRelease, restoreNodeProjectRelease, verifyNodeProjectRelease } from "./_node-project-release.js";
import { prepareManagedRecipeUpdate } from "./_managed-recipe-update.js";
import { randomUUID } from "node:crypto";
import { evaluate } from "../core/runtime/effect-boundary.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import { createNodeRuntimeClient } from "./_node-runtime-client.js";
import { proveNodeRuntimeUnowned } from "./_node-runtime-ownership.js";
import { createGatewayAuthorityNonce, createGatewayAuthoritySecret, signGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_TTL_MS, } from "../platform/gateway-authority.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type { ZelavisAgentProcess, ZelavisAgentProcessRunner, } from "../core/agent/process-command.js";
import { ZelavisProjectValidationError } from "../project.js";
import type { ZelavisProjectLogEntry, ZelavisProjectRecipeLock, ZelavisProjectRuntimeDriver, ZelavisProjectRuntimeSnapshot, } from "../project.js";
export interface NodeProcessProjectRuntimeOptions {
    directory: string;
    /** Project-scoped SDK integration beside a managed third-party workload. */
    integrationOnly?: boolean;
    /**
     * Agent that executes this Project's process.
     *
     * Defaults to the local runner, which is this host executing it itself. The
     * driver issues the same command whichever Agent runs it, which is the point
     * of routing through the contract before a remote one exists.
     */
    agent?: ZelavisAgentProcessRunner;
    startupTimeoutMs?: number;
    startupConcurrency?: number;
    shutdownConcurrency?: number;
    logLimit?: number;
    /** Where an installed or checked-out recipe package lies, so it can be frozen into a Project. */
    recipePackageDirectory?: (name: string, version?: string) => Promise<string | undefined> | string | undefined;
    /** Gives a starting Project the allow-list this Platform holds (see `LocalMarketplace.handDown`). */
    handDownAllowlist?: (projectDataDirectory: string) => Promise<void>;
    /** Installer-acquired exact engines. No package acquisition occurs here. */
    runtimeCatalog?: { readonly directory: string; readonly rootOwned: boolean };
}
interface NodeProjectProcess {
    boundEngineVersion?: string;
    process?: ZelavisAgentProcess;
    control?: ReturnType<typeof createNodeRuntimeClient>;
    logs: ZelavisProjectLogEntry[];
    snapshot: ZelavisProjectRuntimeSnapshot;
    stopping: boolean;
}
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_STARTUP_CONCURRENCY = 1;
const DEFAULT_SHUTDOWN_CONCURRENCY = 8;
const DEFAULT_LOG_LIMIT = 500;
function isMissingFileError(error: unknown): boolean {
    error = unwrapFailure(error);
    return Boolean(error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT");
}
function positiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
}
export function formatProjectProcessExitError(input: {
    code: number | null;
    signal: NodeJS.Signals | null;
    logs: readonly ZelavisProjectLogEntry[];
}): string {
    const base = `Project process exited${input.code !== null ? ` with code ${input.code}` : ""}${input.signal ? ` after ${input.signal}` : ""}.`;
    const diagnostic = [...input.logs]
        .reverse()
        .find((entry) => entry.stream === "stderr" &&
        /(?:error|exception|cannot|failed|not found)/i.test(entry.message) &&
        !/^\s*at\s/.test(entry.message))?.message.trim();
    if (!diagnostic) {
        return base;
    }
    const summary = diagnostic.length > 600
        ? `${diagnostic.slice(0, 597)}...`
        : diagnostic;
    return `${base} ${summary} See project logs for full output.`;
}
const restrictDirectoryPermissions = Effect.fn("NodeProjects.restrictDirectoryPermissions")(function* (path: string): Effect.fn.Return<void, TaggedFailure> {
    if (process.platform === "win32")
        return;
    return yield* Effect.catch(Effect.gen(function* () {
        (yield* integration(() => chmod(path, 0o700)));
    }), Effect.fn("NodeProjects.recover")(function* (_error) {
    }));
});
/** Largest single log message retained per Project. */
export const MAX_CHILD_LOG_MESSAGE_BYTES = 8 * 1024;
const INHERITED_PROJECT_ENVIRONMENT = Object.freeze([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "NODE_ENV",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    // Where the officially maintained services lie in a development checkout, so a
    // Project's marketplace offers them too. A path, not a secret.
    "ZELAVIS_OFFICIAL_SERVICES_DIR",
]);
/**
 * The address a Project announced, if this line is its readiness event.
 *
 * Shared by starting and attaching: a Platform that reconnects to a Project
 * already running learns the address the same way it would have learned it
 * live, by reading the line the Project wrote. Anything else is ordinary
 * output.
 */
function readyUrl(line: string): string | undefined {
    try {
        const event = JSON.parse(line) as {
            type?: unknown;
            url?: unknown;
        };
        if (event.type !== "ready" || typeof event.url !== "string") return undefined;
        const url = new URL(event.url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return undefined;
        return url.origin;
    }
    catch {
        return undefined;
    }
}
export function projectProcessEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const name of INHERITED_PROJECT_ENVIRONMENT) {
        const value = process.env[name];
        if (value !== undefined) {
            environment[name] = value;
        }
    }
    return environment;
}
export function createNodeProcessProjectRuntime(options: NodeProcessProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
    const projectsDirectory = resolve(options.directory);
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const startupConcurrency = positiveInteger(options.startupConcurrency, DEFAULT_STARTUP_CONCURRENCY);
    const shutdownConcurrency = positiveInteger(options.shutdownConcurrency, DEFAULT_SHUTDOWN_CONCURRENCY);
    const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
    const runnerPath = fileURLToPath(new URL("./_node-project-runner.js", import.meta.url));
    const installation = describeInstallation(fileURLToPath(new URL("../cli.js", import.meta.url)));
    const catalogConfiguration = Effect.fn("NodeProjects.catalogConfiguration")(function* () {
        if (options.runtimeCatalog) return options.runtimeCatalog;
        if (installation.kind !== "packaged" || !installation.root) return undefined;
        const directory = join(installation.root, "releases");
        const stats = yield* integration(() => lstat(directory));
        return { directory, rootOwned: stats.uid === 0 };
    });
    const agent = options.agent ??
        createLocalAgentProcessRunner({
            // Beside the Projects it runs, so a Platform restarted against the same
            // data directory finds what the previous one left behind.
            stateDirectory: join(projectsDirectory, ".agent-processes"),
        });
    const processes = new Map<string, NodeProjectProcess>();
    /**
     * Per-runtime Gateway signing secrets.
     *
     * Held only in memory: the secret authenticates the Platform to one child
     * process, so it must not reach the persisted Project record or the System
     * Store, and it dies with the process that issued it.
     */
    const gatewaySecrets = new Map<string, string>();
    let closed = false;
    const closingRuns = new Map<string, Deferred.Deferred<void, TaggedFailure>>();
    function projectDirectory(projectId: string): string {
        return join(projectsDirectory, projectId);
    }
    const runtimeDataDirectory = (id: string) => join(projectDirectory(id), ".zelavis", ...(options.integrationOnly ? ["integration"] : []));
    function appendLog(state: NodeProjectProcess, stream: ZelavisProjectLogEntry["stream"], message: string) {
        const trimmed = message.trimEnd();
        if (!trimmed) {
            return;
        }
        // The log limit counts entries, so a single enormous line could still
        // retain unbounded memory. Truncate explicitly rather than silently.
        const normalized = trimmed.length > MAX_CHILD_LOG_MESSAGE_BYTES
            ? `${trimmed.slice(0, MAX_CHILD_LOG_MESSAGE_BYTES)}… (truncated ${trimmed.length - MAX_CHILD_LOG_MESSAGE_BYTES} bytes)`
            : trimmed;
        state.logs.push({
            timestamp: new Date().toISOString(),
            stream,
            message: normalized,
        });
        if (state.logs.length > logLimit) {
            state.logs.splice(0, state.logs.length - logLimit);
        }
    }
    function stoppedSnapshot(state?: NodeProjectProcess): ZelavisProjectRuntimeSnapshot {
        return {
            status: "stopped",
            stoppedAt: state?.snapshot.stoppedAt ?? new Date().toISOString(),
        };
    }
    const capabilities = {
        independentRuntimeVersion: Boolean(options.runtimeCatalog || installation.kind === "packaged"),
        zeroDowntimeUpdates: true,
        recipeUpdateMode: "engine" as const,
        movable: false,
        liveMigration: false,
        secureIsolation: false,
        resourceLimits: false,
        persistentFilesystem: true,
        statelessRuntimeReplicas: false,
        managedStorage: true,
        managedDatabase: true,
        databaseReplication: false,
        tenantPlacement: false,
        databaseSharding: false,
        runtimeOwnership: "platform-process" as const,
        survivesControlPlaneRestart: agent.survivesControlPlaneRestart === true,
        description: "Runs each trusted project in a separate Node.js process and data directory. This is operational isolation, not a security sandbox.",
    };
    const driver: EffectOperations<ZelavisProjectRuntimeDriver> = {
        name: "node-process",
        runtimeKinds: Object.freeze(["native"]),
        defaultRuntimeKind: "native",
        startupConcurrency,
        supportsLiveUpdate: () => true,
        capabilities: () => capabilities,
        versions: Effect.fn("NodeProjects.versions")(function* (project) {
            const configuration = yield* catalogConfiguration();
            if (!configuration || project && (project.recipe.name !== "@zelavis/app" || project.runtimeKind !== "native"))
                return { selectable: false, reason: "Engine version selection requires an installer-managed native Zelavis App.", versions: [] };
            const versions = yield* createNodeRuntimeCatalog(configuration).list();
            const current = project ? (yield* readCreationEngine(projectDirectory(project.id))).runtime?.version : undefined;
            return { selectable: true, current, latest: versions.find(value => value.status === "available")?.version, versions };
        }),
        resolveVersion: Effect.fn("NodeProjects.resolveVersion")(function* (project, version) {
            const configuration = yield* catalogConfiguration();
            if (!configuration || project.recipe.name !== "@zelavis/app" || project.runtimeKind !== "native") {
                if (version !== undefined) return yield* Effect.fail(new ZelavisProjectValidationError("Engine version selection requires an installer-managed native Zelavis App."));
                return undefined;
            }
            const catalog = createNodeRuntimeCatalog(configuration);
            const selected = yield* (version === undefined ? catalog.latest() : catalog.select(version)).pipe(Effect.mapError(error => new ZelavisProjectValidationError(error.message)));
            const app = yield* catalog.app(selected.version).pipe(Effect.mapError(error => new ZelavisProjectValidationError(error.message)));
            return { engineVersion: selected.version, recipe: app.recipe };
        }),
        prepareUpdate: Effect.fn("NodeProjects.prepareUpdate")(function* (previous, candidate) {
            const state = processes.get(previous.id);
            if (!state?.process?.running || !state.control) return yield* new IntegrationFailure(new Error("Project has no running handover host."));
            const before = yield* state.control.request({ action: "status" });
            if (before.requiresRecovery === true) return yield* new IntegrationFailure(new Error("Project host requires fenced recovery before another update."));
            const selected = yield* evaluate(() => {
                const value = before.release as RuntimeRelease;
                if (!value || typeof value.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) throw new Error("Project host returned an invalid release selection.");
                return value;
            });
            const directory = projectDirectory(previous.id);
            if (options.integrationOnly) {
                const source = yield* integration(() => options.recipePackageDirectory?.(candidate.recipe.name, candidate.recipe.version));
                if (!source) return yield* new IntegrationFailure(new Error("Managed recipe source is unavailable."));
                return yield* prepareManagedRecipeUpdate(directory, previous, candidate, source, selected);
            }
            const engine = yield* readCreationEngine(directory);
            const installedCatalog = yield* catalogConfiguration();
            // A deliberate App upgrade selects the latest qualified engine as
            // well as its recipe. Parent replacement alone never changes this pin.
            if (installedCatalog) {
                const catalog = createNodeRuntimeCatalog(installedCatalog);
                engine.runtime = yield* (candidate.engineVersion ? catalog.select(candidate.engineVersion) : catalog.latest());
            }
            const staging = join(directory, ".zelavis", "update-preparation", randomUUID());
            yield* integration(() => mkdir(staging, { recursive: true, mode: 0o700 }));
            return yield* Effect.gen(function* () {
                const app = installedCatalog && candidate.recipe.name === "@zelavis/app" && engine.runtime
                    ? yield* createNodeRuntimeCatalog(installedCatalog).app(engine.runtime.version) : undefined;
                if (app && app.recipe.version !== candidate.recipe.version) return yield* new IntegrationFailure(new Error("Selected engine and App recipe do not match."));
                const artifact = yield* integration(() => ensureRecipeArtifact(candidate.recipe, staging, join(staging, ".zelavis"),
                    app ? () => app.packageDirectory : options.recipePackageDirectory));
                const manifest = yield* integration(() => readFile(join(staging, ".zelavis", "recipe", "package", "package.json"), "utf8"));
                if (yield* evaluate(() => JSON.parse(manifest).zelavis?.project?.runtime !== undefined)) return yield* new IntegrationFailure(new Error("A live App update cannot switch to a recipe with another runtime contract."));
                const recipe = { ...candidate.recipe, artifact };
                yield* integration(() => writeFile(join(staging, "project.json"), JSON.stringify({ ...candidate, recipe, engine,
                    runtime: { driver: driver.name, capabilities: driver.capabilities(candidate) } }), { mode: 0o600 }));
                const target = yield* freezeNodeProjectRelease(directory, staging, engine.runtime?.version ?? ZELAVIS_VERSION);
                return { mode: "engine" as const, previous: selected, target, recipe };
            }).pipe(Effect.ensuring(integration(() => rm(staging, { recursive: true, force: true })).pipe(Effect.orDie)));
        }),
        applyUpdate: Effect.fn("NodeProjects.applyUpdate")(function* (projectId, update, commit) {
            if (update.mode !== (options.integrationOnly ? "integration" : "engine")) return yield* new IntegrationFailure(new Error("Native App handover requires an engine update."));
            const state = processes.get(projectId);
            if (!state?.process?.running || !state.control) return yield* new IntegrationFailure(new Error("Project handover host is not running."));
            const same = (a: RuntimeRelease, b: RuntimeRelease) => a.version === b.version && a.digest === b.digest;
            const current = yield* state.control.request({ action: "status" });
            if (!same(current.release as RuntimeRelease, update.previous)) return yield* new IntegrationFailure(new Error("Project update no longer names the selected previous runtime."));
            const outcome = yield* state.control.request({ action: "replace", release: update.target, commit: true }, {
                timeoutMs: 150_000,
                commit: Effect.fn("NodeProjects.commitUpdate")(function* (selected, generation) {
                    if (!Number.isSafeInteger(generation) || generation < 1) return yield* new IntegrationFailure(new Error("Invalid Project handover generation."));
                    if (!same(selected, update.previous) && !same(selected, update.target)) return yield* new IntegrationFailure(new Error("Project host requested a lock outside this update."));
                    yield* restoreNodeProjectRelease(projectDirectory(projectId), projectId, selected);
                    yield* integration(() => commit(same(selected, update.target) ? "target" : "previous"));
                }),
            });
            if (outcome.type !== "replaced") return yield* new IntegrationFailure(new Error("Project host did not acknowledge handover completion."));
            return state.snapshot;
        }),
        recoverUpdate: Effect.fn("NodeProjects.recoverUpdate")(function* (projectId, update) {
            if (update.mode !== (options.integrationOnly ? "integration" : "engine")) return yield* new IntegrationFailure(new Error("Native App recovery requires an engine update."));
            const state = processes.get(projectId);
            let selected: RuntimeRelease;
            if (state?.process?.running && state.control) {
                const status = yield* state.control.request({ action: "status" });
                if (status.requiresRecovery === true) return yield* new IntegrationFailure(new Error("Project runtime ownership requires fenced recovery."));
                selected = status.release as RuntimeRelease;
            } else {
                yield* proveNodeRuntimeUnowned(runtimeDataDirectory(projectId));
                const source = yield* integration(() => readFile(join(runtimeDataDirectory(projectId), "runtime-handover.json"), "utf8"));
                selected = yield* evaluate(() => {
                    const journal = JSON.parse(source);
                    if (journal.format !== "zelavis-runtime/1" || !Number.isSafeInteger(journal.generation) || journal.generation < 1) throw new Error("Invalid Project runtime recovery journal.");
                    return journal.selected as RuntimeRelease;
                });
            }
            const choice = yield* evaluate(() => {
                if (selected?.version === update.target.version && selected.digest === update.target.digest) return "target" as const;
                if (selected?.version === update.previous.version && selected.digest === update.previous.digest) return "previous" as const;
                throw new Error("Project runtime selection does not belong to its persisted update.");
            });
            yield* restoreNodeProjectRelease(projectDirectory(projectId), projectId, selected);
            return choice;
        }),
        prepare: Effect.fn("NodeProjects.prepare")(function* (project: Parameters<NonNullable<ZelavisProjectRuntimeDriver["prepare"]>>[0], recipe: Parameters<NonNullable<ZelavisProjectRuntimeDriver["prepare"]>>[1]) {
            const directory = projectDirectory(project.id);
            const dataDirectory = join(directory, ".zelavis");
            // Project data and the descriptor are owner-only: on a permissive umask
            // or a shared service account they would otherwise be readable by other
            // local users.
            yield* integration(() => mkdir(dataDirectory, { recursive: true, mode: 0o700 }));
            yield* restrictDirectoryPermissions(directory);
            yield* restrictDirectoryPermissions(dataDirectory);
            yield* integration(() => options.handDownAllowlist?.(dataDirectory));
            // Freeze the recipe into the Project so a Platform upgrade cannot change
            // what it runs. Preparing fails, with the reason, when it cannot be frozen.
            const engine = yield* readCreationEngine(directory);
            const catalogOptions = yield* catalogConfiguration();
            let app: { packageDirectory: string; recipe: ZelavisProjectRecipeLock } | undefined;
            if (catalogOptions) {
                const catalog = createNodeRuntimeCatalog(catalogOptions);
                const selected = project.engineVersion ? yield* catalog.select(project.engineVersion)
                    : engine.runtime ? yield* catalog.select(engine.runtime.version) : yield* catalog.latest();
                if (engine.runtime && (!project.engineVersion || project.engineVersion === engine.runtime.version) && engine.runtime.digest !== selected.digest)
                    return yield* new IntegrationFailure(new Error("The installed engine differs from this Project's exact runtime lock."));
                engine.runtime = selected;
                if (recipe.name === "@zelavis/app") {
                    const selectedApp = yield* catalog.app(selected.version);
                    app = selectedApp;
                    if (selectedApp.recipe.version !== recipe.version) return yield* new IntegrationFailure(new Error("Selected engine and App recipe do not match."));
                }
            }
            const artifact = yield* integration(() => ensureRecipeArtifact(recipe, directory, dataDirectory,
                app ? () => app!.packageDirectory : options.recipePackageDirectory));
            yield* integration(() => writeFile(join(directory, "project.json"), `${JSON.stringify({
                ...project,
                recipe: {
                    ...(recipe satisfies ZelavisProjectRecipeLock),
                    artifact,
                },
                engine,
                runtime: {
                    driver: driver.name,
                    capabilities: driver.capabilities(project),
                },
            }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
        }),
        adopt: Effect.fn("NodeProjects.adopt")(function* () {
            if (!agent.attach)
                return;
            const directories = ((yield* Effect.orElseSucceed(integration(() => readdir(projectsDirectory, { withFileTypes: true })), () => [])))
                .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
                .map(entry => entry.name);
            for (const projectId of directories) {
                const frozenManifest = yield* integration(() => readFile(join(projectDirectory(projectId), ".zelavis", "recipe", "package", "package.json"), "utf8")).pipe(Effect.catchIf(isMissingFileError, () => Effect.void));
                if (frozenManifest) {
                    const customRuntime = yield* evaluate(() => Boolean(JSON.parse(frozenManifest).zelavis?.project?.runtime));
                    if (options.integrationOnly ? !customRuntime : customRuntime) continue;
                }
                // A canonical recipe swap can be interrupted while a verified
                // snapshot is serving. Adoption must still reach that host so
                // durable intent recovery can restore the selected recipe.
                const descriptor = yield* integration(() => readFile(join(projectDirectory(projectId), "project.json"), "utf8"));
                if ((yield* evaluate(() => JSON.parse(descriptor).kind)) === "frontend") continue;
                const attached = yield* Effect.catch(integration(() => agent.attach!(projectId)), Effect.fn("NodeProjects.recover")(function* () { return []; }));
                for (const { process: child, command, replay } of attached) {
                    const runner = command.args?.[0];
                    if (!runner?.endsWith("/_node-project-runner.js") || command.cwd !== projectDirectory(projectId) ||
                        command.args?.includes("--integration") !== (options.integrationOnly === true)) continue;
                    if (child.workloadId !== projectId) return yield* new IntegrationFailure(new Error("Agent returned a runtime for another Project."));
                    if (!child.listen || !child.write) return yield* new IntegrationFailure(new Error("Agent cannot authenticate re-keying of this persistent Project host."));
                    const state: NodeProjectProcess = {
                        process: child,
                        logs: [],
                        snapshot: { status: "running" },
                        stopping: false,
                    };
                    state.control = createNodeRuntimeClient(child, startupTimeoutMs);
                    processes.set(projectId, state);
                    for (const { stream, line } of replay) {
                        const url = readyUrl(line);
                        if (url) {
                            state.snapshot = { status: "running", url };
                            continue;
                        }
                        appendLog(state, stream, line);
                    }
                    appendLog(state, "system", state.snapshot.url
                        ? `Re-attached to a running Project at ${state.snapshot.url}.`
                        : "Re-attached to a running Project whose address is no longer in the Agent's buffer.");
                    child.listen?.(({ stream, line }) => {
                        if (stream === "stdout" && state.control?.accept(line)) return;
                        const url = readyUrl(line);
                        if (url) {
                            state.snapshot = { status: "running", url };
                            appendLog(state, "system", `Project ready at ${url}.`);
                            return;
                        }
                        appendLog(state, stream, line);
                    });
                    void child.exit.then(({ code, signal, requested }) => {
                        state.control?.exited();
                        const stoppedAt = new Date().toISOString();
                        state.snapshot =
                            requested || state.stopping || code === 0
                                ? { status: "stopped", stoppedAt }
                                : {
                                    status: "failed",
                                    stoppedAt,
                                    error: formatProjectProcessExitError({
                                        code,
                                        signal: signal as NodeJS.Signals | null,
                                        logs: state.logs,
                                    }),
                                };
                    });
                    const secret = createGatewayAuthoritySecret();
                    const reply = yield* state.control.request({ action: "rotate-key", secret });
                    if (reply.type !== "key-rotated") return yield* new IntegrationFailure(new Error("Project host did not acknowledge Gateway re-keying."));
                    const url = readyUrl(JSON.stringify({ type: "ready", url: reply.url }));
                    if (!url) return yield* new IntegrationFailure(new Error("Project host did not report its persistent ingress address."));
                    state.snapshot = { ...state.snapshot, status: "running", url };
                    gatewaySecrets.set(projectId, secret);
                }
            }
        }),
        start: Effect.fn("NodeProjects.start")(function* (project: Parameters<NonNullable<ZelavisProjectRuntimeDriver["start"]>>[0], placement: Parameters<NonNullable<ZelavisProjectRuntimeDriver["start"]>>[1]) {
            if (closed) {
                return yield* new IntegrationFailure(new Error("The Node project runtime is shutting down."));
            }
            const current = processes.get(project.id);
            if (current?.process?.running &&
                (current.snapshot.status === "starting" || current.snapshot.status === "running")) {
                // A managed app's private App follows its control plane engine.
                // Its recipe lock and public app processes remain independent.
                // The persistent host journal is the sole engine selection;
                // interrupted replacement recovers through that same journal.
                if (options.integrationOnly && current.control && current.boundEngineVersion !== ZELAVIS_VERSION) {
                    const status = yield* current.control.request({ action: "status" });
                    const previous = yield* evaluate(() => {
                        const release = status.release as RuntimeRelease;
                        if (status.requiresRecovery === true || !release || typeof release.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(release.digest))
                            throw new Error("Bound Project runtime requires fenced recovery before engine convergence.");
                        return release;
                    });
                    if (previous.version !== ZELAVIS_VERSION) {
                        const catalog = yield* catalogConfiguration();
                        if (catalog) yield* createNodeRuntimeCatalog(catalog).select(ZELAVIS_VERSION);
                        const target = { version: ZELAVIS_VERSION, digest: previous.digest };
                        const { record } = yield* verifyNodeProjectRelease(projectDirectory(project.id), project.id, target);
                        const canonical = yield* integration(() => readFile(join(projectDirectory(project.id), "project.json"), "utf8"));
                        const unchanged = yield* evaluate(() => {
                            const value = JSON.parse(canonical);
                            return value.id === project.id && value.recipe?.name === record.recipe.name && value.recipe?.version === record.recipe.version && value.recipe?.artifact?.digest === record.recipe.artifact.digest;
                        });
                        // Convergence never changes recipe selection. Refuse a
                        // pending canonical recipe swap rather than adopting it.
                        if (!unchanged) return yield* new IntegrationFailure(new Error("Bound Project recipe recovery must finish before engine convergence."));
                        const reply = yield* current.control.request({ action: "replace", release: target, commit: true }, {
                            timeoutMs: 150_000,
                            commit: Effect.fn("NodeProjects.commitBoundEngine")(function* (selected, generation) {
                                if (!Number.isSafeInteger(generation) || generation < 1 || selected.digest !== previous.digest ||
                                    selected.version !== previous.version && selected.version !== target.version)
                                    return yield* new IntegrationFailure(new Error("Bound Project host requested an unqualified engine selection."));
                                // Identical immutable recipe content needs no
                                // canonical rewrite or second registry record.
                            }),
                        });
                        if (reply.type !== "replaced") return yield* new IntegrationFailure(new Error("Bound Project host did not acknowledge engine convergence."));
                    }
                    current.boundEngineVersion = ZELAVIS_VERSION;
                }
                return current.snapshot;
            }
            const directory = projectDirectory(project.id);
            yield* Effect.catch(integration(() => readFile(join(directory, "project.json"), "utf8")), Effect.fn("NodeProjects.recover")(function* (error) {
                if (isMissingFileError(error)) {
                    return (yield* new IntegrationFailure(new Error(`Project "${project.id}" has not been prepared.`)));
                }
                return (yield* error);
            }));
            const catalogOptions = yield* catalogConfiguration();
            const engine = options.integrationOnly
                ? { createdWith: ZELAVIS_VERSION, runtime: catalogOptions ? yield* createNodeRuntimeCatalog(catalogOptions).select(ZELAVIS_VERSION) : undefined }
                : yield* readCreationEngine(directory);
            let executable = process.execPath, selectedRunner = runnerPath;
            if (catalogOptions) {
                if (!engine.runtime) return yield* new IntegrationFailure(new Error("Installed Project has no exact runtime engine lock; prepare it before starting."));
                const execution = yield* createNodeRuntimeCatalog(catalogOptions).resolve(engine.runtime, "project", {}, {});
                executable = execution.executable;
                selectedRunner = join(execution.cwd, "platform", "dist", "adapters", "_node-project-runner.js");
            }
            const initial = yield* freezeNodeProjectRelease(directory, directory, engine.runtime?.version ?? ZELAVIS_VERSION);
            const state: NodeProjectProcess = {
                ...(options.integrationOnly ? { boundEngineVersion: engine.runtime?.version ?? ZELAVIS_VERSION } : {}),
                logs: current?.logs ?? [],
                snapshot: { status: "starting" },
                stopping: false,
            };
            processes.set(project.id, state);
            appendLog(state, "system", `Starting ${project.name} with ${driver.name}.`);
            // A fresh secret per start: a restarted runtime never accepts envelopes
            // signed for its previous process.
            const gatewaySecret = createGatewayAuthoritySecret();
            gatewaySecrets.set(project.id, gatewaySecret);
            const ready = Deferred.makeUnsafe<ZelavisProjectRuntimeSnapshot, TaggedFailure>();
            function finish(error?: Error, snapshot?: ZelavisProjectRuntimeSnapshot) {
                if (error) Deferred.doneUnsafe(ready, Effect.fail(new IntegrationFailure(error)));
                else if (snapshot) Deferred.doneUnsafe(ready, Effect.succeed(snapshot));
            }
            return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
            const child = yield* integration(() => agent.start({
                workloadId: project.id,
                ...(placement ? { placement } : {}),
                executable,
                args: [selectedRunner, ...(options.integrationOnly ? ["--integration"] : [])],
                cwd: directory,
                stdin: "pipe",
                env: {
                    ...projectProcessEnvironment(),
                    PORT: "0",
                    ZELAVIS_PROJECT_GATEWAY_SECRET: gatewaySecret,
                    ZELAVIS_PROJECT_ID: project.id,
                    ZELAVIS_PROJECT_DATA_DIR: join(directory, ".zelavis"),
                    ZELAVIS_PROJECT_INITIAL_RELEASE: JSON.stringify(initial),
                    ...(catalogOptions ? { ZELAVIS_RUNTIME_RELEASES_DIR: catalogOptions.directory, ZELAVIS_RUNTIME_ROOT_OWNED: String(catalogOptions.rootOwned) } : {}),
                    ZELAVIS_UI_DEV_SERVER: "",
                },
            }, {
                onOutput: ({ stream, line }) => {
                    if (stream === "stderr") {
                        appendLog(state, "stderr", line);
                        return;
                    }
                    if (state.control?.accept(line)) return;
                    // The readiness handshake: the child announces the address it
                    // actually bound, because it was started on port 0 and the
                    // Platform cannot know the port until it says so.
                    const url = readyUrl(line);
                    if (url) {
                        const snapshot: ZelavisProjectRuntimeSnapshot = {
                            status: "running",
                            url,
                            startedAt: new Date().toISOString(),
                        };
                        state.snapshot = snapshot;
                        appendLog(state, "system", `Project ready at ${url}.`);
                        finish(undefined, snapshot);
                        return;
                    }
                    appendLog(state, "stdout", line);
                },
                onExit: ({ code, signal, requested }) => {
                    state.control?.exited();
                    const stoppedAt = new Date().toISOString();
                    if (requested || state.stopping || code === 0) {
                        state.snapshot = { status: "stopped", stoppedAt };
                    }
                    else {
                        state.snapshot = {
                            status: "failed",
                            stoppedAt,
                            error: formatProjectProcessExitError({
                                code,
                                signal: signal as NodeJS.Signals | null,
                                logs: state.logs,
                            }),
                        };
                    }
                    appendLog(state, "system", state.snapshot.error ?? "Project stopped.");
                    finish(state.snapshot.status === "failed"
                        ? new Error(state.snapshot.error)
                        : new Error(`Project "${project.id}" stopped before becoming ready.`));
                },
            }));
            state.process = child;
            state.control = createNodeRuntimeClient(child, startupTimeoutMs);
            return yield* restore(Deferred.await(ready).pipe(
                Effect.timeoutOrElse({ duration: startupTimeoutMs,
                    orElse: () => Effect.fail(new IntegrationFailure(new Error(`Project "${project.id}" did not become ready within ${startupTimeoutMs}ms. ${state.logs.slice(-8).map(entry => entry.message).join(" ")}`))) }),
                Effect.onError(cause => Effect.gen(function* () {
                    state.stopping = true;
                    yield* integration(() => child.stop({ graceMs: 2000 })).pipe(Effect.ignore);
                    gatewaySecrets.delete(project.id);
                    state.snapshot = { status: "failed", stoppedAt: new Date().toISOString(), error: String(unwrapFailure(Cause.squash(cause))) };
                })),
            ));
            }));
        }),
        stop: Effect.fn("NodeProjects.stop")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["stop"]>>[0]) {
            const state = processes.get(projectId);
            if (!state?.process?.running) {
                const snapshot = stoppedSnapshot(state);
                if (state) {
                    state.snapshot = snapshot;
                }
                return snapshot;
            }
            state.stopping = true;
            state.snapshot = { ...state.snapshot, status: "stopping" };
            appendLog(state, "system", "Stopping project.");
            // Resolves once the process has actually exited, so reporting "stopped"
            // never describes one that is still running.
            yield* integration(() => state.process!.stop()).pipe(Effect.uninterruptible);
            gatewaySecrets.delete(projectId);
            state.snapshot = stoppedSnapshot(state);
            return state.snapshot;
        }),
        status: Effect.fn("NodeProjects.status")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["status"]>>[0]) {
            return processes.get(projectId)?.snapshot ?? { status: "stopped" };
        }),
        logs: Effect.fn("NodeProjects.logs")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["logs"]>>[0]) {
            return [...(processes.get(projectId)?.logs ?? [])];
        }),
        signGatewayAuthority: Effect.fn("NodeProjects.signGatewayAuthority")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["signGatewayAuthority"]>>[0], claims: Parameters<NonNullable<ZelavisProjectRuntimeDriver["signGatewayAuthority"]>>[1]) {
            const secret = gatewaySecrets.get(projectId);
            // No running child means nothing to authorize against.
            if (!secret)
                return undefined;
            return yield* integration(() => signGatewayAuthority(secret, {
                ...claims,
                nonce: createGatewayAuthorityNonce(),
                expiresAt: Date.now() + ZELAVIS_GATEWAY_AUTHORITY_TTL_MS,
            }));
        }),
        destroy: Effect.fn("NodeProjects.destroy")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["destroy"]>>[0]) {
            yield* driver.stop(projectId);
            processes.delete(projectId);
            gatewaySecrets.delete(projectId);
            yield* integration(() => rm(projectDirectory(projectId), { recursive: true, force: true }));
        }),
        close: () => singleFlight(closingRuns, "close", () => Effect.gen(function* () {
            closed = true;
            yield* Effect.forEach([...processes.keys()], id => driver.stop(id), { concurrency: shutdownConcurrency, discard: true });
        }), true),
    };
    return defineEffectProjectRuntime(driver);
}
const readCreationEngine = Effect.fn("NodeProjects.readCreationEngine")(function* (projectDirectory: string): Effect.fn.Return<{
    createdWith: string;
    runtime?: RuntimeRelease;
}, TaggedFailure> {
    const raw = yield* integration(() => readFile(join(projectDirectory, "project.json"), "utf8")).pipe(Effect.catchIf(isMissingFileError, () => Effect.void));
    if (raw) {
        return yield* evaluate(() => {
            const record = JSON.parse(raw);
            const engine = record.engine;
            if (!engine || typeof engine.createdWith !== "string") throw new Error("Project descriptor has no engine creation identity.");
            if (engine.runtime && (typeof engine.runtime.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(engine.runtime.digest))) throw new Error("Malformed exact Project runtime engine lock.");
            return { createdWith: engine.createdWith, ...(engine.runtime ? { runtime: engine.runtime as RuntimeRelease } : {}) };
        });
    }
    return { createdWith: ZELAVIS_VERSION };
});
