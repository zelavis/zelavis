import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGatewayAuthorityNonce,
  createGatewayAuthoritySecret,
  signGatewayAuthority,
  ZELAVIS_GATEWAY_AUTHORITY_TTL_MS,
} from "../platform/gateway-authority.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type {
  ZelavisAgentProcess,
  ZelavisAgentProcessRunner,
} from "../core/agent/process-command.js";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectRecipeLock,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeSnapshot,
} from "../project.js";

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
}

interface NodeProjectProcess {
  process?: ZelavisAgentProcess;
  logs: ZelavisProjectLogEntry[];
  snapshot: ZelavisProjectRuntimeSnapshot;
  stopping: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_CONCURRENCY = 1;
const DEFAULT_SHUTDOWN_CONCURRENCY = 8;
const DEFAULT_LOG_LIMIT = 500;
function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
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
  const base = `Project process exited${
    input.code !== null ? ` with code ${input.code}` : ""
  }${input.signal ? ` after ${input.signal}` : ""}.`;
  const diagnostic = [...input.logs]
    .reverse()
    .find(
      (entry) =>
        entry.stream === "stderr" &&
        /(?:error|exception|cannot|failed|not found)/i.test(entry.message) &&
        !/^\s*at\s/.test(entry.message),
    )?.message.trim();
  if (!diagnostic) {
    return base;
  }
  const summary = diagnostic.length > 600
    ? `${diagnostic.slice(0, 597)}...`
    : diagnostic;
  return `${base} ${summary} See project logs for full output.`;
}

async function runWithConcurrency<TValue>(
  values: readonly TValue[],
  concurrency: number,
  run: (value: TValue) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      await run(values[nextIndex++]!);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
}

/**
 * Environment variables a Project child process may inherit from the Platform.
 *
 * The local Node driver is operational isolation, not a security sandbox, and
 * advertises `secureIsolation: false`. That honest limitation still does not
 * require handing every Project the control plane's entire environment:
 * inheriting `process.env` wholesale exposes the Platform bootstrap token,
 * provider credentials, signing keys, database URLs, and unrelated service
 * secrets to ordinary Project code.
 *
 * Only variables a Node process genuinely needs to run are forwarded. Project
 * configuration is passed explicitly by the driver, and scoped Project secrets
 * need their own delivery contract rather than ambient inheritance.
 */
/** Narrows a local Project directory to the owning user. Best effort. */
async function restrictDirectoryPermissions(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o700);
  } catch {
    // The host does not support it, or the path vanished under us.
  }
}

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
]);

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

export function createNodeProcessProjectRuntime(
  options: NodeProcessProjectRuntimeOptions,
): ZelavisProjectRuntimeDriver {
  const projectsDirectory = resolve(options.directory);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const startupConcurrency = positiveInteger(
    options.startupConcurrency,
    DEFAULT_STARTUP_CONCURRENCY,
  );
  const shutdownConcurrency = positiveInteger(
    options.shutdownConcurrency,
    DEFAULT_SHUTDOWN_CONCURRENCY,
  );
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const runnerPath = fileURLToPath(new URL("./_node-project-runner.js", import.meta.url));
  const agent =
    options.agent ??
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
  let closePromise: Promise<void> | undefined;

  function projectDirectory(projectId: string): string {
    return join(projectsDirectory, projectId);
  }

  function appendLog(
    state: NodeProjectProcess,
    stream: ZelavisProjectLogEntry["stream"],
    message: string,
  ) {
    const trimmed = message.trimEnd();
    if (!trimmed) {
      return;
    }
    // The log limit counts entries, so a single enormous line could still
    // retain unbounded memory. Truncate explicitly rather than silently.
    const normalized =
      trimmed.length > MAX_CHILD_LOG_MESSAGE_BYTES
        ? `${trimmed.slice(0, MAX_CHILD_LOG_MESSAGE_BYTES)}… (truncated ${
            trimmed.length - MAX_CHILD_LOG_MESSAGE_BYTES
          } bytes)`
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
    survivesControlPlaneRestart: false,
    description:
      "Runs each trusted project in a separate Node.js process and data directory. This is operational isolation, not a security sandbox.",
  };

  const driver: ZelavisProjectRuntimeDriver = {
    name: "node-process",
    runtimeKinds: Object.freeze(["native"]),
    defaultRuntimeKind: "native",
    startupConcurrency,
    capabilities: () => capabilities,
    async prepare(project, recipe) {
      const directory = projectDirectory(project.id);
      const dataDirectory = join(directory, ".zelavis");
      // Project data and the descriptor are owner-only: on a permissive umask
      // or a shared service account they would otherwise be readable by other
      // local users.
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await restrictDirectoryPermissions(directory);
      await restrictDirectoryPermissions(dataDirectory);
      await writeFile(
        join(directory, "project.json"),
        `${JSON.stringify(
          {
            ...project,
            recipe: recipe satisfies ZelavisProjectRecipeLock,
            runtime: {
              driver: driver.name,
              capabilities: driver.capabilities(project),
            },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
    async start(project) {
      if (closed) {
        throw new Error("The Node project runtime is shutting down.");
      }

      const current = processes.get(project.id);
      if (
        current?.process?.running &&
        (current.snapshot.status === "starting" || current.snapshot.status === "running")
      ) {
        return current.snapshot;
      }

      const directory = projectDirectory(project.id);
      await readFile(join(directory, "project.json"), "utf8").catch((error) => {
        if (isMissingFileError(error)) {
          throw new Error(`Project "${project.id}" has not been prepared.`);
        }
        throw error;
      });

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

      let settled = false;
      let readyResolve: (snapshot: ZelavisProjectRuntimeSnapshot) => void;
      let readyReject: (error: Error) => void;
      const ready = new Promise<ZelavisProjectRuntimeSnapshot>(
        (resolveReady, rejectReady) => {
          readyResolve = resolveReady;
          readyReject = rejectReady;
        },
      );
      const timeout = setTimeout(() => {
        finish(
          new Error(
            `Project "${project.id}" did not become ready within ${startupTimeoutMs}ms.`,
          ),
        );
      }, startupTimeoutMs);

      function finish(error?: Error, snapshot?: ZelavisProjectRuntimeSnapshot) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) readyReject(error);
        else if (snapshot) readyResolve(snapshot);
      }

      const child = await agent.start(
        {
          workloadId: project.id,
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
        },
        {
          onOutput: ({ stream, line }) => {
            if (stream === "stderr") {
              appendLog(state, "stderr", line);
              return;
            }

            // The readiness handshake: the child announces the address it
            // actually bound, because it was started on port 0 and the
            // Platform cannot know the port until it says so.
            try {
              const event = JSON.parse(line) as { type?: unknown; url?: unknown };
              if (event.type === "ready" && typeof event.url === "string") {
                const snapshot: ZelavisProjectRuntimeSnapshot = {
                  status: "running",
                  url: event.url,
                  startedAt: new Date().toISOString(),
                };
                state.snapshot = snapshot;
                appendLog(state, "system", `Project ready at ${event.url}.`);
                finish(undefined, snapshot);
                return;
              }
            } catch {
              // Ordinary application output is retained as a project log.
            }
            appendLog(state, "stdout", line);
          },
          onExit: ({ code, signal, requested }) => {
            const stoppedAt = new Date().toISOString();
            if (requested || state.stopping || code === 0) {
              state.snapshot = { status: "stopped", stoppedAt };
            } else {
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
            finish(
              state.snapshot.status === "failed"
                ? new Error(state.snapshot.error)
                : new Error(`Project "${project.id}" stopped before becoming ready.`),
            );
          },
        },
      );
      state.process = child;

      try {
        return await ready;
      } catch (error) {
        // Whatever went wrong, the process must not be left running: a Project
        // reported as failed that is still serving is worse than either state.
        state.stopping = true;
        await child.stop({ graceMs: 2_000 }).catch(() => undefined);
        state.snapshot = {
          status: "failed",
          stoppedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
    async stop(projectId) {
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
      await state.process.stop();
      gatewaySecrets.delete(projectId);
      state.snapshot = stoppedSnapshot(state);
      return state.snapshot;
    },
    async status(projectId) {
      return processes.get(projectId)?.snapshot ?? { status: "stopped" };
    },
    async logs(projectId) {
      return [...(processes.get(projectId)?.logs ?? [])];
    },
    async signGatewayAuthority(projectId, claims) {
      const secret = gatewaySecrets.get(projectId);
      // No running child means nothing to authorize against.
      if (!secret) return undefined;
      return signGatewayAuthority(secret, {
        ...claims,
        nonce: createGatewayAuthorityNonce(),
        expiresAt: Date.now() + ZELAVIS_GATEWAY_AUTHORITY_TTL_MS,
      });
    },
    async destroy(projectId) {
      await driver.stop(projectId);
      processes.delete(projectId);
      gatewaySecrets.delete(projectId);
      await rm(projectDirectory(projectId), { recursive: true, force: true });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        await runWithConcurrency(
          [...processes.keys()],
          shutdownConcurrency,
          async (projectId) => {
            await driver.stop(projectId);
          },
        );
      })();
      return closePromise;
    },
  };

  return driver;
}
