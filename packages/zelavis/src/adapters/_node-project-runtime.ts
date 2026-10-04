import { IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { defineEffectProjectRuntime } from "./project-runtime.js";
import { Cause, Deferred, Effect } from "effect";
import { integration, singleFlight, type EffectOperations } from "../core/runtime/effect-boundary.js";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRecipeArtifact } from "./_recipe-artifact.js";
import { ZELAVIS_VERSION } from "../version.js";
import { createGatewayAuthorityNonce, createGatewayAuthoritySecret, signGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_TTL_MS, } from "../platform/gateway-authority.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type { ZelavisAgentProcess, ZelavisAgentProcessRunner, } from "../core/agent/process-command.js";
import type { ZelavisProjectLogEntry, ZelavisProjectRecipeLock, ZelavisProjectRuntimeDriver, ZelavisProjectRuntimeSnapshot, } from "../project.js";
export interface NodeProcessProjectRuntimeOptions {
    directory: string;
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
}
interface NodeProjectProcess {
    process?: ZelavisAgentProcess;
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
        return event.type === "ready" && typeof event.url === "string"
            ? event.url
            : undefined;
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
        independentRuntimeVersion: false,
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
        capabilities: () => capabilities,
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
            const artifact = yield* integration(() => ensureRecipeArtifact(recipe, directory, dataDirectory, options.recipePackageDirectory));
            // Which engine created this Project. The engine that hosts it is still
            // the Platform's own code, so this is recorded, not enforced: it makes
            // drift between the Project's origin and what runs it visible, and is the
            // field a locked-engine runner would key on.
            const engine = yield* readCreationEngine(directory);
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
                const attached = yield* Effect.catch(integration(() => agent.attach!(projectId)), Effect.fn("NodeProjects.recover")(function* () { return []; }));
                for (const { process: child, replay } of attached) {
                    const state: NodeProjectProcess = {
                        process: child,
                        logs: [],
                        snapshot: { status: "running" },
                        stopping: false,
                    };
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
                        const url = readyUrl(line);
                        if (url) {
                            state.snapshot = { status: "running", url };
                            appendLog(state, "system", `Project ready at ${url}.`);
                            return;
                        }
                        appendLog(state, stream, line);
                    });
                    void child.exit.then(({ code, signal, requested }) => {
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
                return current.snapshot;
            }
            const directory = projectDirectory(project.id);
            yield* Effect.catch(integration(() => readFile(join(directory, "project.json"), "utf8")), Effect.fn("NodeProjects.recover")(function* (error) {
                if (isMissingFileError(error)) {
                    return (yield* new IntegrationFailure(new Error(`Project "${project.id}" has not been prepared.`)));
                }
                return (yield* error);
            }));
            const state: NodeProjectProcess = {
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
                executable: process.execPath,
                args: [runnerPath],
                cwd: directory,
                env: {
                    ...projectProcessEnvironment(),
                    PORT: "0",
                    ZELAVIS_PROJECT_GATEWAY_SECRET: gatewaySecret,
                    ZELAVIS_PROJECT_ID: project.id,
                    ZELAVIS_PROJECT_DATA_DIR: join(directory, ".zelavis"),
                    ZELAVIS_UI_DEV_SERVER: "",
                },
            }, {
                onOutput: ({ stream, line }) => {
                    if (stream === "stderr") {
                        appendLog(state, "stderr", line);
                        return;
                    }
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
            return yield* restore(Deferred.await(ready).pipe(
                Effect.timeoutOrElse({ duration: startupTimeoutMs,
                    orElse: () => Effect.fail(new IntegrationFailure(new Error(`Project "${project.id}" did not become ready within ${startupTimeoutMs}ms.`))) }),
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
}, TaggedFailure> {
    const raw = yield* Effect.catch(integration(() => readFile(join(projectDirectory, "project.json"), "utf8")), Effect.fn("NodeProjects.recover")(function* () { return undefined; }));
    if (raw) {
        const existing = safeCreationEngine(raw);
        if (existing)
            return { createdWith: existing };
    }
    return { createdWith: ZELAVIS_VERSION };
});
function safeCreationEngine(raw: string): string | undefined {
    try {
        const existing = JSON.parse(raw) as {
            engine?: {
                createdWith?: unknown;
            };
        };
        return typeof existing.engine?.createdWith === "string" ? existing.engine.createdWith : undefined;
    }
    catch {
        return undefined;
    }
}
