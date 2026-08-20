import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectRecord,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeSnapshot,
} from "../project.js";
import type { ZelavisBlueprintEntry } from "../blueprint.js";

export interface NodeProcessProjectRuntimeOptions {
  directory: string;
  startupTimeoutMs?: number;
  logLimit?: number;
}

interface NodeProjectProcess {
  child?: ChildProcess;
  logs: ZelavisProjectLogEntry[];
  snapshot: ZelavisProjectRuntimeSnapshot;
  stopping: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
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

export function createNodeProcessProjectRuntime(
  options: NodeProcessProjectRuntimeOptions,
): ZelavisProjectRuntimeDriver {
  const projectsDirectory = resolve(options.directory);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const runnerPath = fileURLToPath(new URL("./_node-project-runner.js", import.meta.url));
  const processes = new Map<string, NodeProjectProcess>();

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

  const driver: ZelavisProjectRuntimeDriver = {
    name: "node-process",
    capabilities: {
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      description:
        "Runs each trusted project in a separate Node.js process and data directory. This is operational isolation, not a security sandbox.",
    },
    async prepare(project, blueprint) {
      const directory = projectDirectory(project.id);
      const dataDirectory = join(directory, ".zelavis");
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(
        join(directory, "blueprint.lock.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectId: project.id,
            installedAt: new Date().toISOString(),
            blueprint: blueprint.manifest,
            runtime: {
              driver: driver.name,
              capabilities: driver.capabilities,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(directory, "project.json"),
        `${JSON.stringify(project, null, 2)}\n`,
        "utf8",
      );
    },
    async start(project) {
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
      await readFile(join(directory, "blueprint.lock.json"), "utf8").catch((error) => {
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

      const child = spawn(process.execPath, [runnerPath], {
        cwd: directory,
        env: {
          ...process.env,
          PORT: "0",
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
              error: `Project process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` after ${signal}` : ""}.`,
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
      state.snapshot = stoppedSnapshot(state);
      return state.snapshot;
    },
    async status(projectId) {
      return processes.get(projectId)?.snapshot ?? { status: "stopped" };
    },
    async logs(projectId) {
      return [...(processes.get(projectId)?.logs ?? [])];
    },
    async destroy(projectId) {
      await driver.stop(projectId);
      processes.delete(projectId);
      await rm(projectDirectory(projectId), { recursive: true, force: true });
    },
  };

  return driver;
}
