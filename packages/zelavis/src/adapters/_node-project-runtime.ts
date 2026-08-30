import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGatewayAuthorityNonce,
  createGatewayAuthoritySecret,
  signGatewayAuthority,
  ZELAVIS_GATEWAY_AUTHORITY_TTL_MS,
  type ZelavisGatewayAuthorityClaims,
} from "../platform/gateway-authority.js";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectApp,
  ZelavisProjectRecord,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeSnapshot,
} from "../project.js";

export interface NodeProcessProjectRuntimeOptions {
  directory: string;
  startupTimeoutMs?: number;
  startupConcurrency?: number;
  shutdownConcurrency?: number;
  logLimit?: number;
}

interface NodeProjectProcess {
  child?: ChildProcess;
  logs: ZelavisProjectLogEntry[];
  snapshot: ZelavisProjectRuntimeSnapshot;
  stopping: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_CONCURRENCY = 1;
const DEFAULT_SHUTDOWN_CONCURRENCY = 8;
const DEFAULT_LOG_LIMIT = 500;
const activeProjectChildren = new Set<ChildProcess>();
let exitCleanupInstalled = false;

function registerProjectChild(child: ChildProcess) {
  activeProjectChildren.add(child);
  child.once("exit", () => activeProjectChildren.delete(child));

  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once("exit", () => {
      for (const activeChild of activeProjectChildren) {
        if (
          activeChild.exitCode === null &&
          activeChild.signalCode === null
        ) {
          activeChild.kill("SIGTERM");
        }
      }
    });
  }
}

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

function projectProcessEnvironment(): Record<string, string> {
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
    const normalized = message.trimEnd();
    if (!normalized) {
      return;
    }
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

  async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
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
    startupConcurrency,
    capabilities: () => capabilities,
    async prepare(project, app) {
      const directory = projectDirectory(project.id);
      const dataDirectory = join(directory, ".zelavis");
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(
        join(directory, "project.json"),
        `${JSON.stringify(
          {
            ...project,
            app: app satisfies ZelavisProjectApp,
            runtime: {
              driver: driver.name,
              capabilities: driver.capabilities(project),
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    },
    async start(project) {
      if (closed) {
        throw new Error("The Node project runtime is shutting down.");
      }

      const current = processes.get(project.id);
      if (
        current?.child &&
        current.child.exitCode === null &&
        current.child.signalCode === null &&
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

      const child = spawn(process.execPath, [runnerPath], {
        cwd: directory,
        env: {
          ...projectProcessEnvironment(),
          PORT: "0",
          ZELAVIS_PROJECT_GATEWAY_SECRET: gatewaySecret,
          ZELAVIS_PROJECT_ID: project.id,
          ZELAVIS_PROJECT_DATA_DIR: join(directory, ".zelavis"),
          ZELAVIS_UI_DEV_SERVER: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child = child;
      registerProjectChild(child);

      let stdoutBuffer = "";
      let settled = false;
      const ready = new Promise<ZelavisProjectRuntimeSnapshot>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => {
          rejectReady(
            new Error(
              `Project "${project.id}" did not become ready within ${startupTimeoutMs}ms.`,
            ),
          );
        }, startupTimeoutMs);

        function finish(error?: Error, snapshot?: ZelavisProjectRuntimeSnapshot) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (error) {
            rejectReady(error);
          } else if (snapshot) {
            resolveReady(snapshot);
          }
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as {
                type?: unknown;
                url?: unknown;
              };
              if (event.type === "ready" && typeof event.url === "string") {
                const snapshot: ZelavisProjectRuntimeSnapshot = {
                  status: "running",
                  url: event.url,
                  startedAt: new Date().toISOString(),
                };
                state.snapshot = snapshot;
                appendLog(state, "system", `Project ready at ${event.url}.`);
                finish(undefined, snapshot);
                continue;
              }
            } catch {
              // Ordinary application output is retained as a project log.
            }
            appendLog(state, "stdout", line);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split("\n")) {
            appendLog(state, "stderr", line);
          }
        });
        child.once("error", (error) => finish(error));
        child.once("exit", (code, signal) => {
          const stoppedAt = new Date().toISOString();
          if (state.stopping || code === 0) {
            state.snapshot = { status: "stopped", stoppedAt };
          } else {
            state.snapshot = {
              status: "failed",
              stoppedAt,
              error: formatProjectProcessExitError({
                code,
                signal,
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
        });
      });

      try {
        return await ready;
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          state.stopping = true;
          child.kill("SIGTERM");
          await waitForExit(child, 2_000);
        }
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
      if (!state?.child || state.child.exitCode !== null || state.child.signalCode !== null) {
        const snapshot = stoppedSnapshot(state);
        if (state) {
          state.snapshot = snapshot;
        }
        return snapshot;
      }

      state.stopping = true;
      state.snapshot = { ...state.snapshot, status: "stopping" };
      appendLog(state, "system", "Stopping project.");
      state.child.kill("SIGTERM");
      await waitForExit(state.child, 5_000);
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
