/**
 * The Agent as its own process.
 *
 * Until now the Agent was a library the Platform called in-process: the same
 * process that served the control plane also owned every Project's child
 * process. That is what made a Platform crash take the supervision down with
 * it — the processes kept running, but nothing was watching them, which is the
 * leak reclamation now cleans up after the fact.
 *
 * Here the Agent runs separately and the Platform drives it over a unix socket.
 * Two things follow. The operator supervises the Agent themselves — systemd,
 * launchd, whatever the host uses — so it is restarted on its own terms rather
 * than inheriting the Platform's lifetime. And the transport between the
 * Platform and process execution becomes explicit, which is the same seam a
 * remote Agent needs; a second implementation changes the transport, not the
 * drivers above it.
 *
 * Re-attachment restores buffered output and exact execution identity. Drivers
 * qualify readiness and placement before adopting surviving processes.
 *
 * The trust boundary is the filesystem. The socket lives in a directory the
 * Agent creates 0700 and the socket itself is 0600, so reaching it means being
 * the user the Agent runs as — who could run the same programs directly. The
 * shared token on top guards the case where that path turns out to be more
 * permissive than intended, which is a configuration mistake worth surviving
 * rather than a threat model of its own.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { evaluate, integration, IntegrationFailure, present, presentOperations, type TaggedFailure } from "../core/runtime/effect-boundary.js";

import type {
  ZelavisAgentAttachedProcess,
  ZelavisAgentProcess,
  ZelavisAgentProcessCommand,
  ZelavisAgentProcessExit,
  ZelavisAgentProcessOutput,
  ZelavisAgentProcessRunner,
  ZelavisAgentProcessStartOptions,
} from "../core/agent/process-command.js";
import type { ZelavisAgentOperationSummary } from "../core/agent/index.js";
import {
  createAgentPlacementLeaseSupervisor,
  type AgentPlacementLease,
  type AgentPlacementIdentity,
  type AgentPlacementLeaseSupervisor,
} from "../core/agent/placement-lease.js";
import type {
  ZelavisHostOperationManifest,
  ZelavisHostOperationRequest,
} from "../core/deployment/index.js";

/** One message is one line, and a line is bounded on both sides. */
const MAX_MESSAGE_LENGTH = 1024 * 1024;

/**
 * How much of a process's output the Agent keeps for a client that is not there.
 *
 * Enough to carry a readiness handshake and the context around a failure, and
 * bounded because a Project that runs for a month with nobody attached must not
 * become the Agent's memory problem. The oldest lines are dropped first, which
 * is the right end to lose: a readiness line is emitted at startup, so a
 * process noisy enough to push it out has been running long enough that a
 * driver polling its port learns the same thing.
 */
const MAX_REPLAY_LINES = 500;

const TOKEN_FILE = "token";
const SOCKET_FILE = "agent.sock";

export interface AgentEndpoint {
  /** Directory holding the socket and its token. */
  readonly directory: string;
}

export function agentSocketPath(directory: string): string {
  return join(directory, SOCKET_FILE);
}

export function agentTokenPath(directory: string): string {
  return join(directory, TOKEN_FILE);
}

/**
 * Creates the endpoint directory, its token, and returns the token.
 *
 * The directory is 0700 and the token 0600 before anything listens on the
 * socket: a window where either is readable is a window where the Agent can be
 * driven by whoever noticed.
 */
async function ensureEndpoint(directory: string, groupAccess = false): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
      groupAccess && (directoryStats.uid !== 0 || directoryStats.gid !== process.getgid?.())) {
    throw new Error("Privileged Agent endpoint must be a root-owned directory in the Agent's group.");
  }
  await chmod(directory, groupAccess ? 0o750 : 0o700);

  const tokenPath = agentTokenPath(directory);
  const stats = await lstat(tokenPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (stats && (!stats.isFile() || stats.isSymbolicLink() || groupAccess &&
      (stats.uid !== 0 || stats.gid !== process.getgid?.() || (stats.mode & 0o027) !== 0))) {
    throw new Error("Agent token must be a regular file owned by its Agent.");
  }
  const existing = stats ? await readFile(tokenPath, "utf8") : undefined;
  if (stats) await chmod(tokenPath, groupAccess ? 0o640 : 0o600);
  if (existing && existing.trim()) return existing.trim();

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { mode: groupAccess ? 0o640 : 0o600, flag: stats ? "w" : "wx" });
  return token;
}

export async function readAgentToken(directory: string): Promise<string> {
  const token = (await readFile(agentTokenPath(directory), "utf8")).trim();
  if (!token) {
    throw new Error(`The Agent token at ${agentTokenPath(directory)} is empty.`);
  }
  return token;
}

/** Constant-time comparison that does not leak length through an exception. */
function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reads newline-delimited JSON messages from a socket.
 *
 * A peer that never sends a newline would otherwise grow this without bound,
 * and a peer that sends something unparseable is a protocol error rather than
 * something to skip past — either way the connection is not usable.
 */
function messageReader(
  onMessage: (message: Record<string, unknown>) => void,
  onProtocolError: (reason: string) => void,
): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_MESSAGE_LENGTH) {
      buffer = "";
      onProtocolError("message exceeded the size limit");
      return;
    }

    for (
      let terminator = buffer.indexOf("\n");
      terminator !== -1;
      terminator = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, terminator);
      buffer = buffer.slice(terminator + 1);
      if (!line.trim()) continue;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        onProtocolError("message was not valid JSON");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        onProtocolError("message was not an object");
        return;
      }
      onMessage(message as Record<string, unknown>);
    }
  };
}

function send(socket: Socket, message: unknown): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function samePlacement(left: AgentPlacementIdentity | undefined, right: unknown): boolean {
  if (!left || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const claim = right as Record<string, unknown>;
  return left.projectId === claim.projectId && left.nodeId === claim.nodeId &&
    left.ownerSession === claim.ownerSession && left.epoch === claim.epoch;
}

// ---------------------------------------------------------------------------
// Server: the Agent process
// ---------------------------------------------------------------------------

export interface AgentProcessServer {
  readonly socketPath: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface AgentProcessServerOptions {
  readonly directory: string;
  /** What actually runs processes. The local runner, in the shipped Agent. */
  readonly runner: ZelavisAgentProcessRunner;
  /** Refuse all process messages. Used by a separately privileged operation Agent. */
  readonly operationsOnly?: boolean;
  /** Root operation Agent socket readable/connectable by its configured service group. */
  readonly endpointGroupAccess?: boolean;
  /** When present, Project processes require current Platform placement. */
  readonly placement?: {
    readonly isProjectWorkload: (workloadId: string) => boolean;
    readonly read: (projectId: string) => Promise<AgentPlacementLease | undefined>;
    readonly checkIntervalMs?: number;
  };
  /**
   * Host operations, when this Agent was started with an installed
   * operation tree. Each request still carries its own signed authority; the
   * socket token only proves the caller may talk to the Agent at all.
   */
  readonly operations?: {
    catalog(): { readonly agentId: string; readonly operations: readonly ZelavisHostOperationManifest[] };
    submit(request: ZelavisHostOperationRequest): Promise<ZelavisAgentOperationSummary>;
    get(operationId: string): Promise<ZelavisAgentOperationSummary | undefined>;
    close?(): Promise<void>;
  };
}

/**
 * Serves one runner over a unix socket.
 *
 * Every connection gets its own view: processes it started are its own, and
 * closing the connection does not stop them — the Agent outliving a Platform
 * is the entire point. What ends them is an explicit stop, or the Agent itself
 * shutting down.
 */
export async function createAgentProcessServer(
  options: AgentProcessServerOptions,
): Promise<AgentProcessServer> {
  const operationsOnly = options.operationsOnly === true;
  if (operationsOnly && !options.operations) {
    throw new Error("An operation-only Agent requires installed host operations.");
  }
  if (options.endpointGroupAccess && (!operationsOnly || process.getuid?.() !== 0)) {
    throw new Error("Group-access endpoints require a root operation-only Agent.");
  }
  const token = await ensureEndpoint(options.directory, options.endpointGroupAccess);
  const socketPath = agentSocketPath(options.directory);

  // A socket file left by a crashed Agent is not a listener; removing it is
  // what makes a restart work rather than fail with EADDRINUSE.
  await rm(socketPath, { force: true });

  /**
   * Live processes, and which connection asked for each.
   *
   * The owner matters for reclamation. A Platform that goes away leaves its
   * processes running here — that is the point — but the Platform replacing it
   * cannot adopt them, so they must be stoppable by whoever comes next.
   * Without the owning connection recorded, the durable records still name this
   * Agent as owner, this Agent is still alive, and the leftovers would be
   * skipped as "someone else's" forever.
   */
  const processes = new Map<
    string,
    {
      child: ZelavisAgentProcess;
      /** The connection currently driving it, or none while detached. */
      socket: Socket | undefined;
      workloadId: string;
      command: ZelavisAgentProcessCommand;
      output: ZelavisAgentProcessOutput[];
      lease?: AgentPlacementLeaseSupervisor;
    }
  >();
  const connections = new Set<Socket>();
  let nextProcessId = 0;

  const server: Server = createServer((socket) => {
    socket.setNoDelay(true);
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    let authenticated = false;

    const fail = (reason: string) => {
      send(socket, { type: "error", error: reason });
      socket.destroy();
    };

    const handle = async (message: Record<string, unknown>) => {
      if (!authenticated) {
        if (
          message.type !== "hello" ||
          typeof message.token !== "string" ||
          !tokensMatch(message.token, token)
        ) {
          fail("authentication failed");
          return;
        }
        authenticated = true;
        send(socket, { type: "hello" });
        return;
      }

      const id = typeof message.id === "string" ? message.id : undefined;

      if (operationsOnly && ![
        "operation.catalog", "operation.submit", "operation.get",
      ].includes(String(message.type))) {
        send(socket, { id, type: "failed", error: "This Agent executes installed host operations only; process commands are refused." });
        return;
      }

      try {
        if (message.type === "start") {
          const processId = `p${(nextProcessId += 1)}`;
          const command = message.command as ZelavisAgentProcessCommand;
          if (!command || typeof command !== "object" || typeof command.workloadId !== "string") {
            send(socket, { id, type: "failed", error: "Process command is invalid." });
            return;
          }
          let lease: AgentPlacementLeaseSupervisor | undefined;
          let childForFence: ZelavisAgentProcess | undefined;
          if (options.placement?.isProjectWorkload(command.workloadId)) {
            if (!command.placement || command.placement.projectId !== command.workloadId) {
              send(socket, { id, type: "failed", error: "Project placement authority is required." });
              return;
            }
            lease = createAgentPlacementLeaseSupervisor({
              identity: command.placement,
              read: options.placement.read,
              checkIntervalMs: options.placement.checkIntervalMs,
              onFence: async () => { await childForFence?.stop(); },
            });
            if (!(await lease.start())) {
              send(socket, { id, type: "failed", error: "Project placement authority is absent or stale." });
              return;
            }
          }
          let child: ZelavisAgentProcess;
          try {
            child = await options.runner.start(command, {
            onOutput: (output) => {
              const entry = processes.get(processId);
              if (entry) {
                entry.output.push(output);
                if (entry.output.length > MAX_REPLAY_LINES) {
                  entry.output.splice(0, entry.output.length - MAX_REPLAY_LINES);
                }
                // Only the connection currently driving it. A detached process
                // still accumulates output; it has nowhere to send it.
                if (entry.socket) {
                  send(entry.socket, { type: "output", processId, ...output });
                }
              }
            },
            onExit: (exit) => {
              const entry = processes.get(processId);
              entry?.lease?.close();
              processes.delete(processId);
              if (entry?.socket) send(entry.socket, { type: "exit", processId, exit });
            },
            });
          } catch (error) {
            lease?.close();
            throw error;
          }
          childForFence = child;
          if (lease?.fenced) {
            await child.stop();
            send(socket, { id, type: "failed", error: "Project placement expired during start." });
            return;
          }
          processes.set(processId, {
            child,
            socket,
            workloadId: command.workloadId,
            command,
            output: [],
            ...(lease ? { lease } : {}),
          });
          send(socket, { id, type: "started", processId });
          return;
        }

        if (message.type === "attach") {
          const workloadId = String(message.workloadId);
          const attached: unknown[] = [];

          for (const [processId, entry] of processes) {
            if (entry.workloadId !== workloadId) continue;
            // Already driven by a live connection: handing the same process to
            // two Platforms would give both a handle to stop it and neither a
            // complete view of its output.
            if (entry.socket && !entry.socket.destroyed) continue;

            entry.socket = socket;
            attached.push({
              processId,
              command: entry.command,
              replay: entry.output.slice(),
            });
          }

          send(socket, { id, type: "attached", processes: attached });
          return;
        }

        if (message.type === "stop") {
          const entry = processes.get(String(message.processId));
          if (entry && options.placement?.isProjectWorkload(entry.workloadId) &&
              !samePlacement(entry.command.placement, message.placement)) {
            send(socket, { id, type: "failed", error: "Project stop authority does not match the process placement." });
            return;
          }
          entry?.lease?.close();
          const child = entry?.child;
          const exit = child
            ? await child.stop(
                typeof message.graceMs === "number"
                  ? { graceMs: message.graceMs }
                  : undefined,
              )
            : undefined;
          send(socket, { id, type: "stopped", exit });
          return;
        }

        if (message.type === "fence.placement") {
          const claim = message.placement;
          if (!claim || typeof claim !== "object" || Array.isArray(claim) ||
              !options.placement || !options.runner.fencePlacement ||
              typeof (claim as AgentPlacementIdentity).projectId !== "string") {
            send(socket, { id, type: "failed", error: "Placement fencing is unavailable." });
            return;
          }
          const placement = claim as AgentPlacementIdentity;
          const current = await options.placement.read(placement.projectId);
          if (!current || current.state !== "active" ||
              current.leaseExpiresAt > current.authorityNow ||
              !samePlacement(placement, current)) {
            send(socket, { id, type: "failed", error: "The prior placement is not expired and current." });
            return;
          }
          const fenced = await options.runner.fencePlacement(placement);
          send(socket, { id, type: "fenced", fenced });
          return;
        }

        if (message.type === "write") {
          const child = processes.get(String(message.processId))?.child;
          if (typeof message.data !== "string") {
            send(socket, { id, type: "failed", error: "Process input must be a string." });
            return;
          }
          const accepted = child?.write ? await child.write(message.data) : false;
          send(socket, { id, type: "written", accepted });
          return;
        }

        if (message.type === "signal") {
          const child = processes.get(String(message.processId))?.child;
          if (typeof message.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(message.signal)) {
            send(socket, { id, type: "failed", error: "Process signal is invalid." });
            return;
          }
          const accepted = child?.signal ? await child.signal(message.signal) : false;
          send(socket, { id, type: "signalled", accepted });
          return;
        }

        if (message.type === "reclaim") {
          const workloadId =
            typeof message.workloadId === "string" ? message.workloadId : undefined;
          const preservePrefixes = Array.isArray(message.preservePrefixes)
            ? message.preservePrefixes.filter((value): value is string => typeof value === "string" && value.length > 0)
            : [];

          // Abandoned first: processes whose Platform disconnected without
          // stopping them. Nothing can drive them any more — this Agent still
          // holds their pipes, but no client has a handle — so leaving them
          // running is the leak, not the feature.
          let count = 0;
          for (const [processId, entry] of [...processes]) {
            if (entry.socket && !entry.socket.destroyed) continue;
            if (workloadId !== undefined && entry.workloadId !== workloadId) continue;
            if (workloadId === undefined && preservePrefixes.some((prefix) => entry.workloadId.startsWith(prefix))) continue;
            processes.delete(processId);
            await entry.child.stop().catch(() => undefined);
            count += 1;
          }

          // Then the durable records, which cover what an earlier *Agent* left
          // behind rather than an earlier Platform.
          count += (await options.runner.reclaim?.(workloadId)) ?? 0;
          send(socket, { id, type: "reclaimed", count });
          return;
        }

        if (message.type === "operation.catalog") {
          if (!options.operations) {
            send(socket, { id, type: "failed", error: "This Agent does not execute host operations." });
            return;
          }
          send(socket, { id, type: "catalog", catalog: options.operations.catalog() });
          return;
        }

        if (message.type === "operation.submit" || message.type === "operation.get") {
          if (!options.operations) {
            send(socket, { id, type: "failed", error: "This Agent does not execute host operations." });
            return;
          }
          const operation = message.type === "operation.submit"
            ? await options.operations.submit(message.request as ZelavisHostOperationRequest)
            : await options.operations.get(String(message.operationId));
          send(socket, { id, type: "operation", operation: operation ?? null });
          return;
        }

        fail(`unknown message type "${String(message.type)}"`);
      } catch (error) {
        send(socket, {
          id,
          type: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    socket.on(
      "data",
      messageReader(
        (message) => void handle(message),
        (reason) => fail(reason),
      ),
    );
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  // Only after it exists. Creating the socket and then narrowing it leaves a
  // window, which is why the directory is 0700 first — this is the second lock,
  // not the only one.
  await chmod(socketPath, options.endpointGroupAccess ? 0o660 : 0o600);

  return {
    socketPath,
    token,
    async close() {
      await options.operations?.close?.();
      await options.runner.close();
      // `server.close` stops accepting and then waits for open connections. An
      // Agent shutting down cannot wait for a Platform to notice: the
      // connections are dropped, which is what the Platform sees anyway when
      // the Agent goes away.
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(socketPath, { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Client: the Platform's view of the Agent
// ---------------------------------------------------------------------------

export interface AgentHostOperationClient {
  hostOperationCatalog(): Promise<{
    readonly agentId: string;
    readonly operations: readonly ZelavisHostOperationManifest[];
  }>;
  submitHostOperation(request: ZelavisHostOperationRequest): Promise<ZelavisAgentOperationSummary>;
  getHostOperation(operationId: string): Promise<ZelavisAgentOperationSummary | undefined>;
}

export interface AgentProcessClientOptions {
  readonly directory: string;
  /** Overrides the token file, for a host that delivers it another way. */
  readonly token?: string;
  readonly connectTimeoutMs?: number;
}

/**
 * A runner backed by an Agent process.
 *
 * Implements the same contract as the local runner, so the drivers above it
 * are unchanged — which is the point of having put them behind the contract
 * first.
 */
const createAgentProcessClientProgram = Effect.fn("AgentIPC.connect")(function* (
  options: AgentProcessClientOptions,
): Effect.fn.Return<ZelavisAgentProcessRunner & AgentHostOperationClient & { close(): Promise<void> }, TaggedFailure> {
  const socketPath = agentSocketPath(options.directory);
  const token = options.token ?? (yield* integration(() => readAgentToken(options.directory)));

  const socket = connect(socketPath);
  socket.setNoDelay(true);

  const handshaken = Deferred.makeUnsafe<void, TaggedFailure>();
  const pending = new Map<string, Deferred.Deferred<Record<string, unknown>, TaggedFailure>>();
  const listeners = new Map<
    string,
    {
      onOutput?: ZelavisAgentProcessStartOptions["onOutput"];
      settle: (exit: ZelavisAgentProcessExit) => void;
    }
  >();
  let nextRequest = 0;
  let disconnected: Error | undefined;

  const abandon = (error: Error) => {
    disconnected ??= error;
    Deferred.doneUnsafe(handshaken, Effect.fail(new IntegrationFailure(error)));
    for (const [, waiter] of pending) Deferred.doneUnsafe(waiter, Effect.fail(new IntegrationFailure(error)));
    pending.clear();
    for (const [, listener] of listeners) {
      // The process may well still be running on the Agent. This settles the
      // caller's promise rather than leaving it pending forever, and reports
      // what is actually known: nothing.
      listener.settle({ code: null, signal: null, requested: false });
    }
    listeners.clear();
  };

  socket.on(
    "data",
    messageReader(
      (message) => {
        if (message.type === "hello") { Deferred.doneUnsafe(handshaken, Effect.void); return; }
        if (message.type === "output") {
          const listener = listeners.get(String(message.processId));
          listener?.onOutput?.({
            stream: message.stream === "stderr" ? "stderr" : "stdout",
            line: String(message.line ?? ""),
          });
          return;
        }
        if (message.type === "exit") {
          const listener = listeners.get(String(message.processId));
          listeners.delete(String(message.processId));
          listener?.settle(message.exit as ZelavisAgentProcessExit);
          return;
        }

        const id = typeof message.id === "string" ? message.id : undefined;
        const waiter = id ? pending.get(id) : undefined;
        if (!waiter) return;
        pending.delete(id!);
        if (message.type === "failed" || message.type === "error") {
          Deferred.doneUnsafe(waiter, Effect.fail(new IntegrationFailure(new Error(String(message.error ?? "Agent request failed.")))));
          return;
        }
        Deferred.doneUnsafe(waiter, Effect.succeed(message));
      },
      (reason) => abandon(new Error(`Agent connection protocol error: ${reason}.`)),
    ),
  );

  socket.on("error", (error) => abandon(error));
  socket.on("close", () =>
    abandon(new Error("The Agent connection closed.")),
  );

  yield* Effect.callback<void, IntegrationFailure>((resume, signal) => {
    const failed = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
    const connected = () => resume(Effect.void);
    socket.once("error", failed); socket.once("connect", connected);
    const aborted = () => socket.destroy(); signal.addEventListener("abort", aborted, { once: true });
    return Effect.sync(() => { socket.off("error", failed); socket.off("connect", connected); signal.removeEventListener("abort", aborted); });
  }).pipe(Effect.timeoutOrElse({ duration: options.connectTimeoutMs ?? 5_000,
    orElse: () => Effect.fail(new IntegrationFailure(new Error(`No Agent is listening at ${socketPath}.`))),
  }), Effect.onError(() => Effect.sync(() => socket.destroy())));

  const request = Effect.fn("AgentIPC.request")(function* (message: Record<string, unknown>) {
    if (disconnected) return yield* Effect.fail(new IntegrationFailure(disconnected));
    if (pending.size >= 128) return yield* Effect.fail(new IntegrationFailure(new Error("Agent request capacity exceeded.")));
    const id = `r${(nextRequest += 1)}`;
    const completion = Deferred.makeUnsafe<Record<string, unknown>, TaggedFailure>();
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => { pending.set(id, completion); }),
      () => evaluate(() => send(socket, { ...message, id })).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.timeoutOrElse({ duration: 120_000,
          orElse: () => Effect.fail(new IntegrationFailure(new Error(`Agent ${String(message.type)} request timed out.`))),
        }),
      ),
      () => Effect.sync(() => { pending.delete(id); }),
    );
  });

  // The handshake before anything else: an unauthenticated connection is
  // dropped by the server, and finding that out on the first `start` would
  // report it as a Project failure.
  yield* evaluate(() => send(socket, { type: "hello", token })).pipe(Effect.onError(() => Effect.sync(() => socket.destroy())));
  yield* Deferred.await(handshaken).pipe(Effect.timeoutOrElse({ duration: options.connectTimeoutMs ?? 5_000,
    orElse: () => Effect.fail(new IntegrationFailure(new Error("The Agent did not answer the handshake."))),
  }), Effect.onError(() => Effect.sync(() => socket.destroy())));

  /** Builds the caller-facing handle for a process id the Agent gave us. */
  function track(
    processId: string,
    workloadId: string,
    startOptions: ZelavisAgentProcessStartOptions,
    placement?: AgentPlacementIdentity,
  ): ZelavisAgentProcess {
    let settled: ZelavisAgentProcessExit | undefined;
    const completion = Deferred.makeUnsafe<ZelavisAgentProcessExit>();
    const exit = present(Deferred.await(completion));
    const settleExit = (value: ZelavisAgentProcessExit) => {
      if (settled) return;
      settled = value;
      Deferred.doneUnsafe(completion, Effect.succeed(value));
      startOptions.onExit?.(value);
    };

    listeners.set(processId, {
      ...(startOptions.onOutput ? { onOutput: startOptions.onOutput } : {}),
      settle: (value) => settleExit(value),
    });

    const methods = presentOperations({
        stop: Effect.fn("AgentIPC.stop")(function* (stopOptions?: { graceMs?: number }) {
          if (settled) return settled;
          yield* request({ type: "stop", processId, ...(placement ? { placement } : {}),
            ...(stopOptions?.graceMs === undefined ? {} : { graceMs: stopOptions.graceMs }) });
          return yield* Deferred.await(completion);
        }),
        write: Effect.fn("AgentIPC.write")(function* (data: string) {
          if (settled) return false;
          const result = yield* request({ type: "write", processId, data });
          return result.accepted === true;
        }),
        signal: Effect.fn("AgentIPC.signal")(function* (signal: string) {
          if (settled) return false;
          const result = yield* request({ type: "signal", processId, signal });
          return result.accepted === true;
        }),
      });
    return {
      id: processId,
      workloadId,
      get running() {
        return !settled;
      },
      exit,
      ...methods,
      listen(onOutput: (output: ZelavisAgentProcessOutput) => void) {
        const existing = listeners.get(processId);
        if (existing) existing.onOutput = onOutput;
      },
    } satisfies ZelavisAgentProcess;
  }

  const starter = presentOperations({
      start: Effect.fn("AgentIPC.start")(function* (command: ZelavisAgentProcessCommand, startOptions: ZelavisAgentProcessStartOptions = {}) {
        const started = yield* request({ type: "start", command });
        return track(String(started.processId), command.workloadId, startOptions, command.placement);
      }),
    });
  const operations = presentOperations({
      hostOperationCatalog: Effect.fn("AgentIPC.operationCatalog")(function* () {
        const result = yield* request({ type: "operation.catalog" });
        return result.catalog as { agentId: string; operations: readonly ZelavisHostOperationManifest[] };
      }),
      submitHostOperation: Effect.fn("AgentIPC.submitOperation")(function* (operationRequest: ZelavisHostOperationRequest) {
        const result = yield* request({ type: "operation.submit", request: operationRequest });
        return result.operation as ZelavisAgentOperationSummary;
      }),
      getHostOperation: Effect.fn("AgentIPC.getOperation")(function* (operationId: string) {
        const result = yield* request({ type: "operation.get", operationId });
        return (result.operation ?? undefined) as ZelavisAgentOperationSummary | undefined;
      }),
      reclaim: Effect.fn("AgentIPC.reclaim")(function* (workloadId?: string, reclaimOptions?: { preservePrefixes?: readonly string[] }) {
        const result = yield* request({ type: "reclaim", ...(workloadId === undefined ? {} : { workloadId }),
          ...(reclaimOptions?.preservePrefixes?.length ? { preservePrefixes: reclaimOptions.preservePrefixes } : {}) });
        return Number(result.count ?? 0);
      }),
      fencePlacement: Effect.fn("AgentIPC.fencePlacement")(function* (placement: AgentPlacementIdentity) {
        const result = yield* request({ type: "fence.placement", placement });
        return result.fenced === true;
      }),
      // Disconnecting transfers custody without stopping supervised Projects.
      close: () => Effect.sync(() => { socket.destroy(); }),
    });
  return {
    name: "agent-ipc",
    // A process the Agent runs outlives the Platform that asked for it, which
    // is the whole reason to run the Agent separately.
    survivesControlPlaneRestart: true,

    ...starter,

    attach: workloadId => present(Effect.gen(function* () {
      const result = yield* request({ type: "attach", workloadId });
      const entries = Array.isArray(result.processes) ? result.processes : [];
      return yield* evaluate(() => entries.map((entry) => {
        const value = entry as {
          processId: string;
          command?: ZelavisAgentProcessCommand;
          replay?: readonly ZelavisAgentProcessOutput[];
        };
        if (!value.command || value.command.workloadId !== workloadId || typeof value.command.executable !== "string" || typeof value.command.cwd !== "string") throw new Error("Agent adoption response has no exact execution identity.");
        return {
          // No listeners yet: the caller supplies them by re-registering
          // through `onOutput` on the handle it gets back, and the replay it
          // is handed here is what it missed.
          process: track(String(value.processId), workloadId, {}, value.command?.placement),
          command: { workloadId, executable: value.command.executable, cwd: value.command.cwd,
            ...(value.command.args ? { args: [...value.command.args] } : {}) },
          replay: value.replay ?? [],
        } satisfies ZelavisAgentAttachedProcess;
      }));
    })),

    ...operations,
  };
});
export function createAgentProcessClient(options: AgentProcessClientOptions): Promise<ZelavisAgentProcessRunner & AgentHostOperationClient & { close(): Promise<void> }> { return present(createAgentProcessClientProgram(options)); }
