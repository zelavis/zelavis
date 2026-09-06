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
 * What this deliberately does not yet do is let Projects survive a Platform
 * restart. The Agent keeps running them, but a new Platform gets a new client
 * with no handles to processes an earlier client started: it cannot receive
 * their output, observe their readiness, or stop them through the contract.
 * Re-attachment needs the Agent to replay what it has buffered and the drivers
 * to re-derive readiness from it, which is its own piece of work. Until then
 * `survivesControlPlaneRestart` stays false, and it is false for a reason that
 * is written down rather than assumed.
 *
 * The trust boundary is the filesystem. The socket lives in a directory the
 * Agent creates 0700 and the socket itself is 0600, so reaching it means being
 * the user the Agent runs as — who could run the same programs directly. The
 * shared token on top guards the case where that path turns out to be more
 * permissive than intended, which is a configuration mistake worth surviving
 * rather than a threat model of its own.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type {
  ZelavisAgentAttachedProcess,
  ZelavisAgentProcess,
  ZelavisAgentProcessCommand,
  ZelavisAgentProcessExit,
  ZelavisAgentProcessOutput,
  ZelavisAgentProcessRunner,
  ZelavisAgentProcessStartOptions,
} from "../core/agent/process-command.js";

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
async function ensureEndpoint(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const tokenPath = agentTokenPath(directory);
  const existing = await readFile(tokenPath, "utf8").catch(() => undefined);
  if (existing && existing.trim()) return existing.trim();

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
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
  const token = await ensureEndpoint(options.directory);
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

      try {
        if (message.type === "start") {
          const processId = `p${(nextProcessId += 1)}`;
          const command = message.command as ZelavisAgentProcessCommand;
          const child = await options.runner.start(command, {
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
              processes.delete(processId);
              if (entry?.socket) send(entry.socket, { type: "exit", processId, exit });
            },
          });
          processes.set(processId, {
            child,
            socket,
            workloadId: command.workloadId,
            command,
            output: [],
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
          const child = processes.get(String(message.processId))?.child;
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

        if (message.type === "reclaim") {
          const workloadId =
            typeof message.workloadId === "string" ? message.workloadId : undefined;

          // Abandoned first: processes whose Platform disconnected without
          // stopping them. Nothing can drive them any more — this Agent still
          // holds their pipes, but no client has a handle — so leaving them
          // running is the leak, not the feature.
          let count = 0;
          for (const [processId, entry] of [...processes]) {
            if (entry.socket && !entry.socket.destroyed) continue;
            if (workloadId !== undefined && entry.workloadId !== workloadId) continue;
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
  await chmod(socketPath, 0o600).catch(() => undefined);

  return {
    socketPath,
    token,
    async close() {
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
export async function createAgentProcessClient(
  options: AgentProcessClientOptions,
): Promise<ZelavisAgentProcessRunner & { close(): Promise<void> }> {
  const socketPath = agentSocketPath(options.directory);
  const token = options.token ?? (await readAgentToken(options.directory));

  const socket = connect(socketPath);
  socket.setNoDelay(true);

  interface Pending {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }
  const pending = new Map<string, Pending>();
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
    for (const [, waiter] of pending) waiter.reject(error);
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
          waiter.reject(new Error(String(message.error ?? "Agent request failed.")));
          return;
        }
        waiter.resolve(message);
      },
      (reason) => abandon(new Error(`Agent connection protocol error: ${reason}.`)),
    ),
  );

  socket.on("error", (error) => abandon(error));
  socket.on("close", () =>
    abandon(new Error("The Agent connection closed.")),
  );

  await new Promise<void>((resolveConnect, rejectConnect) => {
    const timer = setTimeout(
      () => rejectConnect(new Error(`No Agent is listening at ${socketPath}.`)),
      options.connectTimeoutMs ?? 5_000,
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectConnect(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnect();
    });
  });

  function request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (disconnected) return Promise.reject(disconnected);
    const id = `r${(nextRequest += 1)}`;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      send(socket, { ...message, id });
    });
  }

  // The handshake before anything else: an unauthenticated connection is
  // dropped by the server, and finding that out on the first `start` would
  // report it as a Project failure.
  send(socket, { type: "hello", token });
  await new Promise<void>((resolveHello, rejectHello) => {
    const timer = setTimeout(
      () => rejectHello(new Error("The Agent did not answer the handshake.")),
      options.connectTimeoutMs ?? 5_000,
    );
    const onData = (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes('"hello"')) return;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      resolveHello();
    };
    socket.on("data", onData);
    socket.once("close", () => {
      clearTimeout(timer);
      rejectHello(new Error("The Agent rejected the connection."));
    });
  });

  /** Builds the caller-facing handle for a process id the Agent gave us. */
  function track(
    processId: string,
    workloadId: string,
    startOptions: ZelavisAgentProcessStartOptions,
  ): ZelavisAgentProcess {
    let settled: ZelavisAgentProcessExit | undefined;
    let settleExit: (exit: ZelavisAgentProcessExit) => void;
    const exit = new Promise<ZelavisAgentProcessExit>((resolveExit) => {
      settleExit = (value) => {
        if (settled) return;
        settled = value;
        startOptions.onExit?.(value);
        resolveExit(value);
      };
    });

    listeners.set(processId, {
      ...(startOptions.onOutput ? { onOutput: startOptions.onOutput } : {}),
      settle: (value) => settleExit(value),
    });

    return {
      workloadId,
      get running() {
        return !settled;
      },
      exit,
      async stop(stopOptions) {
        if (settled) return settled;
        await request({
          type: "stop",
          processId,
          ...(stopOptions?.graceMs === undefined
            ? {}
            : { graceMs: stopOptions.graceMs }),
        });
        return exit;
      },
      listen(onOutput: (output: ZelavisAgentProcessOutput) => void) {
        const existing = listeners.get(processId);
        if (existing) existing.onOutput = onOutput;
      },
    } satisfies ZelavisAgentProcess;
  }

  return {
    name: "agent-ipc",
    // A process the Agent runs outlives the Platform that asked for it, which
    // is the whole reason to run the Agent separately.
    survivesControlPlaneRestart: true,

    async start(command, startOptions = {}) {
      const started = await request({ type: "start", command });
      return track(String(started.processId), command.workloadId, startOptions);
    },

    async attach(workloadId) {
      const result = await request({ type: "attach", workloadId });
      const entries = Array.isArray(result.processes) ? result.processes : [];

      return entries.map((entry) => {
        const value = entry as {
          processId: string;
          replay?: readonly ZelavisAgentProcessOutput[];
        };
        return {
          // No listeners yet: the caller supplies them by re-registering
          // through `onOutput` on the handle it gets back, and the replay it
          // is handed here is what it missed.
          process: track(String(value.processId), workloadId, {}),
          replay: value.replay ?? [],
        } satisfies ZelavisAgentAttachedProcess;
      });
    },

    async reclaim(workloadId) {
      const result = await request({
        type: "reclaim",
        ...(workloadId === undefined ? {} : { workloadId }),
      });
      return Number(result.count ?? 0);
    },

    async close() {
      // Disconnects; it does not stop what the Agent is running. A Platform
      // shutting down is not a reason to take an operator's Projects offline —
      // that is what supervising the Agent separately buys.
      socket.destroy();
    },
  };
}
