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
import { Cause, Deferred, Effect, Fiber } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { acquireAgentEndpointLock } from "./_agent-endpoint-lock.js";
import { arrayOf, isBoolean, isPositiveInteger, isString, objectFields, optional, parseJson } from "../core/json-validation.js";
import { ZELAVIS_VERSION } from "../version.js";
import { evaluate, integration, IntegrationFailure, present, presentOperations, type TaggedFailure, integrationValue, unwrapFailure } from "../core/runtime/effect-boundary.js";

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
const MAX_REPLAY_BYTES = 64 * 1024;
function retainOutput(output: ZelavisAgentProcessOutput[], next: ZelavisAgentProcessOutput) {
  output.push(next);
  let bytes = output.reduce((total, item) => total + Buffer.byteLength(item.line), 0);
  while (output.length > MAX_REPLAY_LINES || bytes > MAX_REPLAY_BYTES) bytes -= Buffer.byteLength(output.shift()!.line);
}


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
function ensureEndpoint(directory: string, groupAccess = false): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  (yield* integrationValue(mkdir(directory, { recursive: true, mode: 0o700 })));
  const directoryStats = (yield* integrationValue(lstat(directory)));
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
      groupAccess && (directoryStats.uid !== 0 || directoryStats.gid !== process.getgid?.())) {
    throw new Error("Privileged Agent endpoint must be a root-owned directory in the Agent's group.");
  }
  (yield* integrationValue(chmod(directory, groupAccess ? 0o750 : 0o700)));

  const tokenPath = agentTokenPath(directory);
  const stats = (yield* integrationValue(lstat(tokenPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  })));
  if (stats && (!stats.isFile() || stats.isSymbolicLink() || groupAccess &&
      (stats.uid !== 0 || stats.gid !== process.getgid?.() || (stats.mode & 0o027) !== 0))) {
    throw new Error("Agent token must be a regular file owned by its Agent.");
  }
  const existing = stats ? (yield* integrationValue(readFile(tokenPath, "utf8"))) : undefined;
  if (stats) (yield* integrationValue(chmod(tokenPath, groupAccess ? 0o640 : 0o600)));
  if (existing && existing.trim()) return (yield* integrationValue(existing.trim()));

  const token = randomBytes(32).toString("base64url");
  (yield* integrationValue(writeFile(tokenPath, `${token}\n`, { mode: groupAccess ? 0o640 : 0o600, flag: stats ? "w" : "wx" })));
  return token;
}));
  }

export function readAgentToken(directory: string): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  const token = ((yield* integrationValue(readFile(agentTokenPath(directory), "utf8")))).trim();
  if (!token) {
    throw new Error(`The Agent token at ${agentTokenPath(directory)} is empty.`);
  }
  return token;
}));
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
  close(options?: { readonly preserveProcesses?: boolean }): Promise<void>;
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
export function createAgentProcessServer(
  options: AgentProcessServerOptions,
): Promise<AgentProcessServer> {
  let guard: DatabaseSync | undefined;
  return present(Effect.gen(function* (): Effect.fn.Return<AgentProcessServer, IntegrationFailure> {
  const operationsOnly = options.operationsOnly === true;
  if (operationsOnly && !options.operations) {
    throw new Error("An operation-only Agent requires installed host operations.");
  }
  if (options.endpointGroupAccess && (!operationsOnly || process.getuid?.() !== 0)) {
    throw new Error("Group-access endpoints require a root operation-only Agent.");
  }
  guard = yield* acquireAgentEndpointLock(options.directory);
  const token = yield* integrationValue(ensureEndpoint(options.directory, options.endpointGroupAccess));
  const socketPath = agentSocketPath(options.directory);

  // A socket file left by a crashed Agent is not a listener; removing it is
  // what makes a restart work rather than fail with EADDRINUSE.
  yield* integrationValue(rm(socketPath, { force: true }));

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
  const supervisors = new Set<Socket>();
  let nextProcessId = 0;
  const generation = randomBytes(24).toString("base64url");
  const recoveryWatchers = new Set<Fiber.Fiber<void, never>>();
  const recovered = (yield* integration(() => options.runner.recover?.())) ?? [];
  for (const attached of recovered) {
    const child = attached.process, processId = child.id;
    if (!processId || !child.listen) return yield* new IntegrationFailure(new Error("Recovered Agent process lacks stable identity or output control."));
    const entry: { child: ZelavisAgentProcess; socket: Socket | undefined; workloadId: string; command: ZelavisAgentProcessCommand;
      output: ZelavisAgentProcessOutput[]; lease?: AgentPlacementLeaseSupervisor } = {
      child, socket: undefined, workloadId: child.workloadId, command: { ...attached.command, env: {} }, output: attached.replay.slice(),
    };
    if (options.placement?.isProjectWorkload(child.workloadId)) {
      if (!entry.command.placement) return yield* new IntegrationFailure(new Error("Recovered Project process has no placement identity."));
      entry.lease = createAgentPlacementLeaseSupervisor({ identity: entry.command.placement, read: options.placement.read,
        checkIntervalMs: options.placement.checkIntervalMs, onFence: () => present(integration(() => child.stop()).pipe(Effect.asVoid)) });
      if (!(yield* integration(() => entry.lease!.start()))) continue;
    }
    if (!child.running) { entry.lease?.close(); continue; }
    processes.set(processId, entry);
    child.listen(output => {
      retainOutput(entry.output, output);
      if (entry.socket) send(entry.socket, { type: "output", processId, ...output });
    });
    // Read-only observation: cancellation releases this generation's waiter;
    // it must not wait for a surviving child during Agent handover.
    const watcher = Effect.runFork(integration(() => child.exit, { interruptible: true }).pipe(Effect.match({
      onSuccess: exit => { entry.lease?.close(); processes.delete(processId); if (entry.socket) send(entry.socket, { type: "exit", processId, exit }); },
      onFailure: error => { console.error(`Recovered Agent process exit could not be observed: ${error.message}`); },
    })));
    recoveryWatchers.add(watcher);
    watcher.addObserver(() => recoveryWatchers.delete(watcher));
  }

  const server: Server = createServer((socket) => {
    socket.setNoDelay(true);
    connections.add(socket);
    socket.once("close", () => { connections.delete(socket); supervisors.delete(socket); });
    let authenticated = false;
    let diagnostic = false;

    const fail = (reason: string) => {
      send(socket, { type: "error", error: reason });
      socket.destroy();
    };

    const handle = (message: Record<string, unknown>): Effect.Effect<void> => {
      const id = typeof message.id === "string" ? message.id : undefined;
      return Effect.gen(function* () {
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
        diagnostic = message.diagnostic === true;
        send(socket, { type: "hello", generation, release: ZELAVIS_VERSION, protocol: "zelavis-agent/1", survivable: options.runner.recover !== undefined });
        return;
      }

      if (message.type === "client.ready") {
        if (!diagnostic) supervisors.add(socket);
        send(socket, { id, type: "ready" }); return;
      }


      if (operationsOnly && ![
        "operation.catalog", "operation.submit", "operation.get",
      ].includes(String(message.type))) {
        send(socket, { id, type: "failed", error: "This Agent executes installed host operations only; process commands are refused." });
        return;
      }

      if (message.type === "inspect") {
        send(socket, { id, type: "inspection", release: ZELAVIS_VERSION, generation,
          readySupervisors: supervisors.size,
          processes: [...processes].map(([id, entry]) => ({ id, pid: entry.child.pid, workloadId: entry.workloadId,
            running: entry.child.running, bound: !!entry.socket && !entry.socket.destroyed })) }); return;
      }

        if (message.type === "start") {
          let processId = `p${(nextProcessId += 1)}`;
          const command = message.command as ZelavisAgentProcessCommand;
          if (!command || typeof command !== "object" || typeof command.workloadId !== "string") {
            send(socket, { id, type: "failed", error: "Process command is invalid." });
            return;
          }
          let earlyExit: ZelavisAgentProcessExit | undefined;
          const earlyOutput: ZelavisAgentProcessOutput[] = [];
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
              onFence: () => present(Effect.gen(function* () { (yield* integrationValue(childForFence?.stop())); })),
            });
            if (!(yield* integrationValue(lease.start()))) {
              send(socket, { id, type: "failed", error: "Project placement authority is absent or stale." });
              return;
            }
          }
          const child: ZelavisAgentProcess = yield* integrationValue(options.runner.start(command, {
            onOutput: (output) => {
              const entry = processes.get(processId);
              if (entry) {
                retainOutput(entry.output, output);
                // Only the connection currently driving it. A detached process
                // still accumulates output; it has nowhere to send it.
                if (entry.socket) {
                  send(entry.socket, { type: "output", processId, ...output });
                }
              } else retainOutput(earlyOutput, output);
            },
            onExit: (exit) => {
              const entry = processes.get(processId);
              if (!entry) earlyExit = exit;
              entry?.lease?.close();
              processes.delete(processId);
              if (entry?.socket) send(entry.socket, { type: "exit", processId, exit });
            },
          })).pipe(Effect.tapError(() => Effect.sync(() => lease?.close())));
          childForFence = child;
          processId = child.id ?? processId;
          if (lease?.fenced) {
            yield* integrationValue(child.stop());
            send(socket, { id, type: "failed", error: "Project placement expired during start." });
            return;
          }
          processes.set(processId, {
            child,
            socket,
            workloadId: command.workloadId,
            command,
            output: earlyOutput,
            ...(lease ? { lease } : {}),
          });
          send(socket, { id, type: "started", processId, replay: earlyOutput, ...(earlyExit ? { exit: earlyExit } : {}) });
          if (earlyExit) { processes.delete(processId); lease?.close(); }
          return;
        }

        if (message.type === "rebind") {
          const processId = String(message.processId), entry = processes.get(processId);
          if (!entry || !entry.child.running) { send(socket, { id, type: "rebound", gone: true, exit: { code: null, signal: null, requested: false } }); return; }
          if (entry.socket && !entry.socket.destroyed && entry.socket !== socket) {
            send(socket, { id, type: "failed", error: "Process already belongs to another live Agent connection." }); return;
          }
          if (options.placement?.isProjectWorkload(entry.workloadId) && !samePlacement(entry.command.placement, message.placement)) {
            send(socket, { id, type: "failed", error: "Project rebind authority does not match its placement." }); return;
          }
          entry.socket = socket;
          send(socket, { id, type: "rebound", command: entry.command, replay: entry.output.slice() });
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
            if (entry.socket && !entry.socket.destroyed && entry.socket !== socket) continue;

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
            ? yield* integrationValue(child.stop(
                typeof message.graceMs === "number"
                  ? { graceMs: message.graceMs }
                  : undefined,
              ))
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
          const current = yield* integrationValue(options.placement.read(placement.projectId));
          if (!current || current.state !== "active" ||
              current.leaseExpiresAt > current.authorityNow ||
              !samePlacement(placement, current)) {
            send(socket, { id, type: "failed", error: "The prior placement is not expired and current." });
            return;
          }
          const fenced = yield* integrationValue(options.runner.fencePlacement(placement));
          send(socket, { id, type: "fenced", fenced });
          return;
        }

        if (message.type === "write") {
          const child = processes.get(String(message.processId))?.child;
          if (typeof message.data !== "string") {
            send(socket, { id, type: "failed", error: "Process input must be a string." });
            return;
          }
          const accepted = child?.write ? yield* integrationValue(child.write(message.data)) : false;
          send(socket, { id, type: "written", accepted });
          return;
        }

        if (message.type === "signal") {
          const child = processes.get(String(message.processId))?.child;
          if (typeof message.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(message.signal)) {
            send(socket, { id, type: "failed", error: "Process signal is invalid." });
            return;
          }
          const accepted = child?.signal ? yield* integrationValue(child.signal(message.signal)) : false;
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
            yield* integrationValue(entry.child.stop()).pipe(Effect.orElseSucceed(() => undefined));
            count += 1;
          }

          // Then the durable records, which cover what an earlier *Agent* left
          // behind rather than an earlier Platform.
          count += (yield* integrationValue(options.runner.reclaim?.(workloadId))) ?? 0;
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
            ? yield* integrationValue(options.operations.submit(message.request as ZelavisHostOperationRequest))
            : yield* integrationValue(options.operations.get(String(message.operationId)));
          send(socket, { id, type: "operation", operation: operation ?? null });
          return;
        }

        fail(`unknown message type "${String(message.type)}"`);
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
        const error = unwrapFailure(Cause.squash(cause));
        send(socket, {
          id,
          type: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })));
    };

    socket.on(
      "data",
      messageReader(
        (message) => { Effect.runFork(handle(message)); },
        (reason) => fail(reason),
      ),
    );
    socket.on("error", () => socket.destroy());
  });

  yield* Effect.callback<void, IntegrationFailure>((resume) => {
    const refuse = (cause: Error) => resume(Effect.fail(new IntegrationFailure(cause)));
    server.once("error", refuse);
    server.listen(socketPath, () => {
      server.removeListener("error", refuse);
      resume(Effect.void);
    });
  });

  // Only after it exists. Creating the socket and then narrowing it leaves a
  // window, which is why the directory is 0700 first — this is the second lock,
  // not the only one.
  yield* integrationValue(chmod(socketPath, options.endpointGroupAccess ? 0o660 : 0o600));

  let closing: Promise<void> | undefined;
  return {
    socketPath,
    token,
    close(closeOptions) {
      return closing ??= present(Effect.gen(function* () {
      yield* integrationValue(options.operations?.close?.());
      for (const entry of processes.values()) entry.lease?.close();
      if (closeOptions?.preserveProcesses) {
        if (!options.runner.detach) return yield* new IntegrationFailure(new Error("This Agent runner cannot release live processes."));
        yield* integration(() => options.runner.detach!());
      } else yield* integrationValue(options.runner.close());
      yield* Effect.forEach([...recoveryWatchers], Fiber.interrupt, { concurrency: 8, discard: true });
      // `server.close` stops accepting and then waits for open connections. An
      // Agent shutting down cannot wait for a Platform to notice: the
      // connections are dropped, which is what the Platform sees anyway when
      // the Agent goes away.
      for (const socket of connections) socket.destroy();
      connections.clear();
      yield* Effect.callback<void>((resume) => { server.close(() => resume(Effect.void)); });
      yield* integrationValue(rm(socketPath, { force: true })).pipe(Effect.orElseSucceed(() => undefined));
      yield* evaluate(() => { guard?.close(); guard = undefined; });
      }));
    },
  };
  }).pipe(Effect.onError(() => evaluate(() => { guard?.close(); guard = undefined; }).pipe(Effect.orDie))));
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
  readonly reconnectTimeoutMs?: number;
  readonly diagnostic?: boolean;
}

export interface AgentInspection {
  readonly release: string;
  readonly generation: string;
  readonly readySupervisors: number;
  readonly processes: readonly { readonly id: string; readonly pid?: number; readonly workloadId: string; readonly running: boolean; readonly bound: boolean }[];
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
): Effect.fn.Return<ZelavisAgentProcessRunner & AgentHostOperationClient & { inspect(): Promise<AgentInspection>; close(): Promise<void> }, TaggedFailure> {
  const socketPath = agentSocketPath(options.directory);

  type Reply = Record<string, unknown>;
  type Pending = { readonly completion: Deferred.Deferred<Reply, TaggedFailure>; readonly message: Reply; readonly retry: boolean };
  const pending = new Map<string, Pending>();
  const earlyExits = new Map<string, ZelavisAgentProcessExit>();
  const handles = new Map<string, ZelavisAgentProcess>();
  const listeners = new Map<string, {
    onOutput?: ZelavisAgentProcessStartOptions["onOutput"];
    readonly placement?: AgentPlacementIdentity;
    readonly generation?: string;
    settle: (exit: ZelavisAgentProcessExit) => void;
  }>();
  let nextRequest = 0, connected = false, established = false, closed = false;
  let socket: Socket | undefined;
  let hello: Reply = {};
  let online = Deferred.makeUnsafe<void, TaggedFailure>();
  let terminal: Error | undefined;
  let recovery: Fiber.Fiber<void, never> | undefined;
  const abandon = (error: Error, explain = true) => {
    terminal = error;
    Deferred.doneUnsafe(online, Effect.fail(new IntegrationFailure(error)));
    for (const entry of pending.values()) Deferred.doneUnsafe(entry.completion, Effect.fail(new IntegrationFailure(error)));
    pending.clear();
    for (const listener of listeners.values()) listener.settle({ code: null, signal: null, requested: false, ...(explain ? { reason: error.message } : {}) });
    listeners.clear(); earlyExits.clear();
  };
  const scheduleRecovery = () => {
    if (closed || terminal || recovery || !established) return;
    recovery = Effect.runFork(reconnect().pipe(
      Effect.catchCause(cause => Effect.sync(() => abandon(new Error(`Agent reconnection failed: ${String(cause)}`)))),
      Effect.ensuring(Effect.sync(() => {
        recovery = undefined;
        if (!closed && !terminal && !connected) scheduleRecovery();
      })),
    ));
  };
  const connectOnce = Effect.fn("AgentIPC.connectOnce")(function* () {
    const currentToken = options.token ?? (yield* integration(() => readAgentToken(options.directory)));
    const candidate = connect(socketPath);
    socket = candidate;
    candidate.setNoDelay(true);
    const ready = Deferred.makeUnsafe<void, TaggedFailure>();
    const lost = (error: Error) => {
      Deferred.doneUnsafe(ready, Effect.fail(new IntegrationFailure(error)));
      if (socket !== candidate || closed) return;
      socket = undefined;
      if (connected) { connected = false; online = Deferred.makeUnsafe(); }
      for (const [id, entry] of pending) if (!entry.retry) {
        pending.delete(id);
        Deferred.doneUnsafe(entry.completion, Effect.fail(new IntegrationFailure(new Error(
          `Agent connection lost during ${String(entry.message.type)}; outcome is unknown and the operation was not replayed.`, { cause: error }))));
      }
      scheduleRecovery();
    };
    candidate.on("data", messageReader(message => {
      if (socket !== candidate || closed) return;
      if (message.type === "hello") { hello = message; Deferred.doneUnsafe(ready, Effect.void); return; }
      if (message.type === "output") {
        listeners.get(String(message.processId))?.onOutput?.({ stream: message.stream === "stderr" ? "stderr" : "stdout", line: String(message.line ?? "") }); return;
      }
      if (message.type === "exit") {
        const id = String(message.processId), listener = listeners.get(id);
        listeners.delete(id);
        if (listener) listener.settle(message.exit as ZelavisAgentProcessExit);
        else if (earlyExits.size < 128) earlyExits.set(id, message.exit as ZelavisAgentProcessExit);
        else abandon(new Error("Agent unclaimed process exit capacity exceeded."));
        return;
      }
      const id = typeof message.id === "string" ? message.id : undefined;
      const waiter = id ? pending.get(id) : undefined;
      if (!id || !waiter) return;
      pending.delete(id);
      Deferred.doneUnsafe(waiter.completion, message.type === "failed" || message.type === "error"
        ? Effect.fail(new IntegrationFailure(new Error(String(message.error ?? "Agent request failed.")))) : Effect.succeed(message));
    }, reason => { lost(new Error(`Agent connection protocol error: ${reason}.`)); candidate.destroy(); }));
    candidate.once("connect", () => send(candidate, { type: "hello", token: currentToken, diagnostic: options.diagnostic === true }));
    candidate.on("error", lost);
    candidate.on("close", () => lost(new Error("The Agent connection closed.")));
    yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: options.connectTimeoutMs ?? 5000,
      orElse: () => Effect.fail(new IntegrationFailure(new Error(`No Agent answered the handshake at ${socketPath}.`))),
    }), Effect.onError(() => Effect.sync(() => candidate.destroy())));
  });
  const request = Effect.fn("AgentIPC.request")(function* (message: Reply, requestOptions?: { readonly direct?: boolean; readonly retry?: boolean }) {
    if (terminal || closed) return yield* new IntegrationFailure(terminal ?? new Error("Agent client is closed."));
    if (!requestOptions?.direct) yield* Deferred.await(online).pipe(Effect.timeoutOrElse({ duration: options.reconnectTimeoutMs ?? 90_000,
      orElse: () => Effect.fail(new IntegrationFailure(new Error("Agent unreachable before request deadline."))),
    }));
    if (!socket || socket.destroyed) return yield* new IntegrationFailure(new Error("Agent connection is unavailable."));
    if (pending.size >= 128) return yield* new IntegrationFailure(new Error("Agent request capacity exceeded."));
    const id = `r${++nextRequest}`, completion = Deferred.makeUnsafe<Reply, TaggedFailure>();
    const retry = requestOptions?.retry ?? ["stop", "operation.catalog", "operation.get", "attach", "reclaim", "fence.placement"].includes(String(message.type));
    return yield* Effect.acquireUseRelease(evaluate(() => {
        if (!socket || socket.destroyed) throw new Error("Agent connection is unavailable.");
        pending.set(id, { completion, message: { ...message, id }, retry });
        try { send(socket, { ...message, id }); }
        catch (cause) { pending.delete(id); throw cause; }
      }),
      () => Deferred.await(completion).pipe(
        Effect.timeoutOrElse({ duration: 120_000, orElse: () => Effect.fail(new IntegrationFailure(new Error(`Agent ${String(message.type)} request timed out.`))) })),
      () => Effect.sync(() => { pending.delete(id); }));
  });
  const reconnect = Effect.fn("AgentIPC.reconnect")(function* () {
    const until = Date.now() + (options.reconnectTimeoutMs ?? 90_000);
    let delay = 50;
    while (!closed && Date.now() < until) {
      const outcome = yield* Effect.result(Effect.gen(function* () {
        yield* connectOnce();
        for (const [processId, listener] of [...listeners]) {
          const stable = /^[a-f0-9-]{36}$/.test(processId) && hello.survivable === true;
          if (hello.protocol !== "zelavis-agent/1" || listener.generation !== hello.generation && !stable) {
            listeners.delete(processId); listener.settle({ code: null, signal: null, requested: false, reason: "Previous Agent did not persist this process handle." }); continue;
          }
          const rebound = yield* request({ type: "rebind", processId, ...(listener.placement ? { placement: listener.placement } : {}) }, { direct: true, retry: false });
          if (rebound.gone === true) {
            listeners.delete(processId); listener.settle(rebound.exit as ZelavisAgentProcessExit); continue;
          }
          if (Array.isArray(rebound.replay)) for (const output of rebound.replay) {
            const line = output as ZelavisAgentProcessOutput;
            listener.onOutput?.(line);
          }
        }
        if (!socket || socket.destroyed) return yield* new IntegrationFailure(new Error("Agent disconnected during process rebind."));
        for (const entry of pending.values()) if (entry.retry) send(socket, entry.message);
        yield* request({ type: "client.ready" }, { direct: true, retry: false });
        connected = true;
        yield* Deferred.succeed(online, undefined);
      }));
      if (outcome._tag === "Success" || closed) return;
      socket?.destroy();
      yield* Effect.sleep(Math.min(delay, Math.max(0, until - Date.now())));
      delay = Math.min(2000, delay * 2);
    }
    if (!closed) abandon(new Error("Agent unreachable: process handles could not be rebound before the recovery deadline."));
  });
  yield* connectOnce();
  if (hello.protocol === "zelavis-agent/1") yield* request({ type: "client.ready" }, { direct: true, retry: false });
  established = true;
  connected = true;
  yield* Deferred.succeed(online, undefined);

  /** Builds the caller-facing handle for a process id the Agent gave us. */
  function track(
    processId: string,
    workloadId: string,
    startOptions: ZelavisAgentProcessStartOptions,
    placement?: AgentPlacementIdentity,
    reconnectableControl = false,
  ): ZelavisAgentProcess {
    const existingHandle = handles.get(processId);
    if (existingHandle) return existingHandle;
    let settled: ZelavisAgentProcessExit | undefined;
    let stopRequested = false;
    const completion = Deferred.makeUnsafe<ZelavisAgentProcessExit>();
    const exit = present(Deferred.await(completion));
    const settleExit = (value: ZelavisAgentProcessExit) => {
      if (settled) return;
      settled = value;
      handles.delete(processId);
      Deferred.doneUnsafe(completion, Effect.succeed(value));
      startOptions.onExit?.(value);
    };

    listeners.set(processId, {
      ...(startOptions.onOutput ? { onOutput: startOptions.onOutput } : {}),
      placement, generation: typeof hello.generation === "string" ? hello.generation : undefined,
      settle: value => settleExit(stopRequested ? { ...value, requested: true } : value),
    });

    const methods = presentOperations({
        stop: Effect.fn("AgentIPC.stop")(function* (stopOptions?: { graceMs?: number }) {
          if (settled) return settled;
          stopRequested = true;
          yield* request({ type: "stop", processId, ...(placement ? { placement } : {}),
            ...(stopOptions?.graceMs === undefined ? {} : { graceMs: stopOptions.graceMs }) });
          return yield* Deferred.await(completion);
        }),
        write: Effect.fn("AgentIPC.write")(function* (data: string) {
          if (settled) return false;
          const result = yield* request({ type: "write", processId, data }, { retry: reconnectableControl });
          return result.accepted === true;
        }),
        signal: Effect.fn("AgentIPC.signal")(function* (signal: string) {
          if (settled) return false;
          const result = yield* request({ type: "signal", processId, signal });
          return result.accepted === true;
        }),
      });
    const handle = {
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
    handles.set(processId, handle);
    const early = earlyExits.get(processId);
    if (early) { earlyExits.delete(processId); listeners.delete(processId); settleExit(early); }
    return handle;
  }

  const starter = presentOperations({
      start: Effect.fn("AgentIPC.start")(function* (command: ZelavisAgentProcessCommand, startOptions: ZelavisAgentProcessStartOptions = {}) {
        const started = yield* request({ type: "start", command });
        const id = String(started.processId);
        if (started.exit) earlyExits.set(id, started.exit as ZelavisAgentProcessExit);
        const child = track(id, command.workloadId, startOptions, command.placement, command.control !== undefined);
        if (Array.isArray(started.replay)) for (const output of started.replay) startOptions.onOutput?.(output as ZelavisAgentProcessOutput);
        return child;
      }),
    });
  const operations = presentOperations({
      inspect: Effect.fn("AgentIPC.inspect")(function* () {
        const reply = yield* request({ type: "inspect" });
        return yield* evaluate(() => parseJson(JSON.stringify(reply), objectFields<AgentInspection>({
          release: isString, generation: isString, readySupervisors: (value): value is number => Number.isInteger(value) && Number(value) >= 0,
          processes: arrayOf(objectFields({ id: isString, pid: optional(isPositiveInteger), workloadId: isString, running: isBoolean, bound: isBoolean })),
        })));
      }),
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
      close: () => Effect.gen(function* () {
        if (closed) return;
        closed = true;
        socket?.destroy();
        if (recovery) yield* Fiber.interrupt(recovery);
        abandon(new Error("Agent client was closed."), false);
      }),
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
          process: track(String(value.processId), workloadId, {}, value.command?.placement, value.command.control !== undefined),
          command: { workloadId, executable: value.command.executable, cwd: value.command.cwd,
            ...(value.command.args ? { args: [...value.command.args] } : {}),
            ...(value.command.placement ? { placement: value.command.placement } : {}),
            ...(value.command.control ? { control: value.command.control } : {}) },
          replay: value.replay ?? [],
        } satisfies ZelavisAgentAttachedProcess;
      }));
    })),

    ...operations,
  };
});
export function createAgentProcessClient(options: AgentProcessClientOptions): Promise<ZelavisAgentProcessRunner & AgentHostOperationClient & { inspect(): Promise<AgentInspection>; close(): Promise<void> }> { return present(createAgentProcessClientProgram(options)); }
