/**
 * Runs a `server` frontend as a Project-owned runtime.
 *
 * A server frontend is an application that brings its own HTTP server — Next,
 * Nuxt, SvelteKit, or anything else that binds a port. It needs a process, a
 * data directory, a lifecycle, logs, and a routed target, which is what a
 * Project already is, so it reuses the Project runtime contract rather than
 * introducing a second supervisor.
 *
 * Readiness is a port check, not a protocol handshake. The official Zelavis
 * runner emits a JSON readiness event on stdout, but an arbitrary frontend
 * knows nothing about Zelavis, so the only portable signal is that the port it
 * was told to bind starts accepting connections.
 */
import { connect, createServer } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  ZelavisProjectRecipeLock,
  ZelavisProjectDescriptor,
  ZelavisProjectLogEntry,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeSnapshot,
} from "../project.js";
import { ZelavisProjectRuntimeError } from "../project.js";
import type { ZelavisProjectDriverCapabilities } from "../core/workload/index.js";
import {
  MAX_CHILD_LOG_MESSAGE_BYTES,
  projectProcessEnvironment,
} from "./_node-project-runtime.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type {
  ZelavisAgentProcess,
  ZelavisAgentProcessRunner,
} from "../core/agent/process-command.js";
import {
  readFrontendManifest,
  type ZelavisServerFrontendManifest,
} from "../core/service/frontend.js";
import type { ZelavisPackageManifest } from "../core/service/manifest.js";

const DEFAULT_PORT_ENV = "PORT";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 100;
const LOG_LIMIT = 200;

export interface ServerFrontendProjectRuntimeOptions {
  /** Root directory holding one subdirectory per Project. */
  readonly directory: string;
  /**
   * Resolves the installed package directory for a frontend specifier.
   *
   * Acquisition — npm, `npx create`, an uploaded archive, a Git source — is a
   * separate concern with its own trust policy. This driver only runs what is
   * already on disk.
   */
  readonly resolveFrontendDirectory: (
    project: Readonly<ZelavisProjectDescriptor>,
    recipe: ZelavisProjectRecipeLock,
  ) => Promise<string>;
  readonly startupTimeoutMs?: number;
  /**
   * Agent that executes the frontend's process.
   *
   * Defaults to the local runner. The driver issues the same command whichever
   * Agent runs it.
   */
  readonly agent?: ZelavisAgentProcessRunner;
}

interface FrontendProcess {
  process?: ZelavisAgentProcess;
  snapshot: ZelavisProjectRuntimeSnapshot;
  logs: ZelavisProjectLogEntry[];
  stopping: boolean;
}

interface PreparedFrontend {
  readonly directory: string;
  readonly start: readonly string[];
  readonly portEnv: string;
}

const capabilities: ZelavisProjectDriverCapabilities = Object.freeze({
  independentRuntimeVersion: true,
  movable: false,
  liveMigration: false,
  // A frontend runs as an ordinary child process. This is operational
  // isolation, not a security sandbox.
  secureIsolation: false,
  resourceLimits: false,
  persistentFilesystem: true,
  statelessRuntimeReplicas: false,
  managedStorage: false,
  managedDatabase: false,
  databaseReplication: false,
  tenantPlacement: false,
  databaseSharding: false,
  runtimeOwnership: "platform-process",
  survivesControlPlaneRestart: false,
  description:
    "Runs a server frontend as a child process owned by the Project it serves.",
});

/** Reserves a free loopback port by binding and immediately releasing it. */
async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a port for the frontend."));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/** True once something accepts a connection on the port. */
async function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolveAccepts) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (accepted: boolean) => {
      socket.destroy();
      resolveAccepts(accepted);
    };
    socket.setTimeout(READINESS_POLL_INTERVAL_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export function createServerFrontendProjectRuntime(
  options: ServerFrontendProjectRuntimeOptions,
): ZelavisProjectRuntimeDriver {
  const root = resolve(options.directory);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const processes = new Map<string, FrontendProcess>();
  const agent = options.agent ?? createLocalAgentProcessRunner();
  const prepared = new Map<string, PreparedFrontend>();

  const projectDirectory = (projectId: string) => join(root, projectId);

  function appendLog(
    state: FrontendProcess,
    stream: ZelavisProjectLogEntry["stream"],
    message: string,
  ): void {
    const trimmed = message.trimEnd();
    if (!trimmed) return;
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
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
  }

  async function readPrepared(projectId: string): Promise<PreparedFrontend> {
    const cached = prepared.get(projectId);
    if (cached) return cached;

    // Survives a Platform restart: the resolved command lives beside the
    // Project rather than only in memory.
    const raw = await readFile(
      join(projectDirectory(projectId), "frontend.json"),
      "utf8",
    ).catch(() => undefined);
    if (!raw) {
      throw new ZelavisProjectRuntimeError(
        `Frontend "${projectId}" has not been prepared.`,
      );
    }
    const value = JSON.parse(raw) as PreparedFrontend;
    prepared.set(projectId, value);
    return value;
  }

  function stoppedSnapshot(state?: FrontendProcess): ZelavisProjectRuntimeSnapshot {
    return {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      ...(state?.snapshot.error ? { error: state.snapshot.error } : {}),
    };
  }

  const driver: ZelavisProjectRuntimeDriver = {
    name: "server-frontend",
    runtimeKinds: Object.freeze(["native" as const]),
    defaultRuntimeKind: "native",
    capabilities: () => capabilities,

    async prepare(project, recipe) {
      const directory = projectDirectory(project.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });

      const packageDirectory = await options.resolveFrontendDirectory(project, recipe);
      const manifestRaw = await readFile(
        join(packageDirectory, "package.json"),
        "utf8",
      ).catch(() => undefined);
      if (!manifestRaw) {
        throw new ZelavisProjectRuntimeError(
          `Frontend "${recipe.specifier}" has no package.json at ${packageDirectory}.`,
        );
      }

      const manifest = JSON.parse(manifestRaw) as ZelavisPackageManifest;
      const frontend = readFrontendManifest(manifest);
      if (!frontend || frontend.runtime !== "server") {
        throw new ZelavisProjectRuntimeError(
          `Frontend "${recipe.specifier}" is not a server frontend.`,
        );
      }

      const value: PreparedFrontend = {
        directory: packageDirectory,
        start: (frontend as ZelavisServerFrontendManifest).start,
        portEnv: (frontend as ZelavisServerFrontendManifest).portEnv ?? DEFAULT_PORT_ENV,
      };
      prepared.set(project.id, value);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(directory, "frontend.json"),
        `${JSON.stringify(value, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      // The Project record too, in the same shape the Zelavis runner writes.
      // The local runtime routes `stop`, `logs`, and `destroy` by reading this
      // file back — those take a Project id, not a descriptor — so a frontend
      // that only wrote `frontend.json` could be started and never stopped.
      await writeFile(
        join(directory, "project.json"),
        `${JSON.stringify(
          {
            ...project,
            recipe,
            runtime: { driver: "server-frontend", capabilities },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },

    async start(project) {
      const plan = await readPrepared(project.id);
      const port = await allocatePort();
      const state: FrontendProcess = {
        logs: processes.get(project.id)?.logs ?? [],
        snapshot: { status: "starting" },
        stopping: false,
      };
      processes.set(project.id, state);
      appendLog(state, "system", `Starting frontend on port ${port}.`);

      const [command, ...args] = plan.start;
      let exited: { code: number | null; signal: string | null } | undefined;
      const child = await agent.start(
        {
          workloadId: project.id,
          executable: command!,
          args,
          cwd: plan.directory,
          env: {
            ...projectProcessEnvironment(),
            [plan.portEnv]: String(port),
          },
        },
        {
          onOutput: ({ stream, line }: { stream: "stdout" | "stderr"; line: string }) =>
            appendLog(state, stream, line),
          onExit: (exit: { code: number | null; signal: string | null }) => {
            exited = exit;
          },
        },
      );
      state.process = child;

      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (exited) {
          const detail = state.logs
            .filter((entry) => entry.stream === "stderr")
            .slice(-5)
            .map((entry) => entry.message)
            .join("\n");
          state.snapshot = {
            status: "failed",
            stoppedAt: new Date().toISOString(),
            error:
              `Frontend exited before binding ${plan.portEnv}=${port} ` +
              `(code ${exited.code}, signal ${exited.signal}).` +
              (detail ? `\n${detail}` : ""),
          };
          throw new ZelavisProjectRuntimeError(state.snapshot.error!);
        }

        if (await portAccepts(port)) {
          state.snapshot = {
            status: "running",
            url: `http://127.0.0.1:${port}`,
            startedAt: new Date().toISOString(),
          };
          appendLog(state, "system", `Frontend ready at ${state.snapshot.url}.`);
          return state.snapshot;
        }

        await new Promise((wait) => setTimeout(wait, READINESS_POLL_INTERVAL_MS));
      }

      state.stopping = true;
      await child.stop().catch(() => undefined);
      state.snapshot = {
        status: "failed",
        stoppedAt: new Date().toISOString(),
        error: `Frontend did not bind ${plan.portEnv}=${port} within ${startupTimeoutMs}ms.`,
      };
      throw new ZelavisProjectRuntimeError(state.snapshot.error!);
    },

    async stop(projectId) {
      const state = processes.get(projectId);
      if (!state?.process?.running) {
        const snapshot = stoppedSnapshot(state);
        if (state) state.snapshot = snapshot;
        return snapshot;
      }

      state.stopping = true;
      appendLog(state, "system", "Stopping frontend.");
      // The Agent escalates SIGTERM to SIGKILL and resolves only once the
      // process is actually gone, so a frontend that ignores SIGTERM cannot
      // hold the lifecycle open.
      await state.process.stop();
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
      prepared.delete(projectId);
      await rm(projectDirectory(projectId), { recursive: true, force: true });
    },

    async close() {
      await Promise.all([...processes.keys()].map((id) => driver.stop(id)));
    },
  };

  return driver;
}
