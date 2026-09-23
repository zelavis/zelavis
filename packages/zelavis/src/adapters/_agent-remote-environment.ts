import { randomUUID } from "node:crypto";

import type {
  ZelavisAgentProcess,
  ZelavisAgentProcessExit,
  ZelavisAgentProcessOutput,
  ZelavisAgentProcessRunner,
} from "../core/agent/process-command.js";
import type {
  ZelavisEnvironmentEvent,
  ZelavisEnvironmentEventPage,
  ZelavisEnvironmentEventReadOptions,
  ZelavisEnvironmentOperationInput,
  ZelavisEnvironmentOperationResult,
  ZelavisEnvironmentProcess,
  ZelavisEnvironmentProcessInput,
  ZelavisEnvironmentSession,
  ZelavisEnvironmentSessionInput,
  ZelavisRemoteEnvironment,
} from "../platform/remote-environment.js";

const DEFAULT_EVENT_LIMIT = 200;
const MAX_REPLAY_EVENTS = 2_000;
export const REMOTE_ENVIRONMENT_WORKLOAD_PREFIX = "environment:";
const ALLOWED_SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
  "SIGUSR1",
  "SIGUSR2",
  "SIGWINCH",
]);

interface SessionState {
  record: ZelavisEnvironmentSession;
  processes: Set<string>;
  events: ZelavisEnvironmentEvent[];
  cursorEpoch: string;
  nextSequence: number;
  droppedThrough: number;
}

interface ProcessState {
  record: ZelavisEnvironmentProcess;
  handle: ZelavisAgentProcess;
}

export interface AgentRemoteEnvironmentOptions {
  readonly runner: ZelavisAgentProcessRunner;
  readonly id?: string;
  readonly name?: string;
  readonly eventLimit?: number;
}

const eventCursor = (session: SessionState, sequence: number) =>
  `e${session.cursorEpoch}.${sequence.toString(36)}`;

function cursorSequence(cursor: string, session: SessionState): number | undefined {
  const match = /^e([0-9a-f]{32})\.([0-9a-z]+)$/.exec(cursor);
  // The cursor is opaque. A well-formed cursor from an earlier provider
  // incarnation is stale rather than invalid, and must restart from the
  // retained tail. Accept the original sequence-only shape for the same
  // backwards-compatible reason.
  if (!match) {
    if (/^e[0-9a-z]+$/.test(cursor)) return undefined;
    throw new Error("Environment event cursor is invalid.");
  }
  if (match[1] !== session.cursorEpoch) return undefined;
  const sequence = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Environment event cursor is invalid.");
  return sequence;
}

/**
 * Projects the supervised Agent process runner into Zelavis's tenant/session
 * environment contract. The runner remains the only component that spawns or
 * signals children; this adapter owns session identity and replay semantics.
 */
export function createAgentRemoteEnvironment(
  options: AgentRemoteEnvironmentOptions,
): ZelavisRemoteEnvironment {
  const sessions = new Map<string, SessionState>();
  const processes = new Map<string, ProcessState>();
  const retainedEvents = Math.max(1, Math.floor(options.eventLimit ?? MAX_REPLAY_EVENTS));

  const requireSession = (sessionId: string): SessionState => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Environment session ${sessionId} is not attached.`);
    return session;
  };

  const appendEvent = (
    session: SessionState,
    event: Omit<ZelavisEnvironmentEvent, "cursor" | "sessionId" | "timestamp">,
  ) => {
    const sequence = session.nextSequence++;
    session.events.push({
      ...event,
      cursor: eventCursor(session, sequence),
      sessionId: session.record.id,
      timestamp: new Date().toISOString(),
    });
    if (session.events.length > retainedEvents) {
      session.events.splice(0, session.events.length - retainedEvents);
      session.droppedThrough = sequence - session.events.length;
    }
  };

  const registerProcess = (
    session: SessionState,
    processId: string,
    handle: ZelavisAgentProcess,
    replay: readonly ZelavisAgentProcessOutput[] = [],
  ): ProcessState => {
    const existing = processes.get(processId);
    if (existing) return existing;
    const state: ProcessState = {
      handle,
      record: {
        id: processId,
        sessionId: session.record.id,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
    processes.set(processId, state);
    session.processes.add(processId);
    const output = (entry: ZelavisAgentProcessOutput) => appendEvent(session, {
      processId,
      type: entry.stream,
      data: entry.line,
    });
    for (const entry of replay) output(entry);
    handle.listen?.(output);
    void handle.exit.then((exit) => settleProcess(session, state, exit));
    appendEvent(session, { processId, type: "status", status: "running" });
    return state;
  };

  const settleProcess = (
    session: SessionState,
    process: ProcessState,
    exit: ZelavisAgentProcessExit,
  ) => {
    if (process.record.status === "exited" || process.record.status === "failed") return;
    const status = exit.code === null && exit.signal === null ? "failed" as const : "exited" as const;
    process.record = {
      ...process.record,
      status,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
    };
    appendEvent(session, {
      processId: process.record.id,
      type: "exit",
      status,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
    });
  };

  const attach = async (session: SessionState) => {
    if (!options.runner.attach) return;
    const attached = await options.runner.attach(`${REMOTE_ENVIRONMENT_WORKLOAD_PREFIX}${session.record.id}`);
    for (const entry of attached) {
      const id = `${session.record.id}:${entry.process.id ?? randomUUID()}`;
      registerProcess(session, id, entry.process, entry.replay);
    }
  };

  return {
    identity: {
      id: options.id ?? `zelavis-agent-${options.runner.name}`,
      name: options.name ?? "Zelavis Agent environment",
      platform: "node",
      capabilities: ["sessions", "processes", "stdin", "signals", "termination", "event-replay"],
    },

    health: () => ({
      status: "healthy",
      checkedAt: new Date().toISOString(),
      message: `Process runner: ${options.runner.name}`,
    }),

    async createSession(input: ZelavisEnvironmentSessionInput) {
      const id = randomUUID();
      const record: ZelavisEnvironmentSession = {
        id,
        status: "active",
        createdAt: new Date().toISOString(),
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      sessions.set(id, {
        record,
        processes: new Set(),
        events: [],
        cursorEpoch: randomUUID().replaceAll("-", ""),
        nextSequence: 1,
        droppedThrough: 0,
      });
      return record;
    },

    async resumeSession(record) {
      if (record.status !== "active") return record;
      let session = sessions.get(record.id);
      if (!session) {
        session = {
          record,
          processes: new Set(),
          events: [],
          cursorEpoch: randomUUID().replaceAll("-", ""),
          nextSequence: 1,
          droppedThrough: 0,
        };
        sessions.set(record.id, session);
        await attach(session);
      }
      return session.record;
    },

    async closeSession(sessionId) {
      const session = requireSession(sessionId);
      for (const processId of session.processes) {
        const process = processes.get(processId);
        if (process?.handle.running) await process.handle.stop().catch(() => undefined);
      }
      session.record = { ...session.record, status: "closed" };
    },

    async startProcess(sessionId: string, input: ZelavisEnvironmentProcessInput) {
      const session = requireSession(sessionId);
      if (session.record.status !== "active") throw new Error("Environment session is closed.");
      const pendingOutput: ZelavisAgentProcessOutput[] = [];
      let outputListener: ((entry: ZelavisAgentProcessOutput) => void) | undefined;
      let pendingExit: ZelavisAgentProcessExit | undefined;
      let exitListener: ((exit: ZelavisAgentProcessExit) => void) | undefined;
      const handle = await options.runner.start({
        workloadId: `${REMOTE_ENVIRONMENT_WORKLOAD_PREFIX}${sessionId}`,
        executable: input.command,
        args: input.args,
        cwd: input.cwd,
        stdin: "pipe",
        env: input.env ?? {},
      }, {
        onOutput: (entry) => outputListener ? outputListener(entry) : pendingOutput.push(entry),
        onExit: (exit) => exitListener ? exitListener(exit) : (pendingExit = exit),
      });
      const processId = `${sessionId}:${handle.id ?? randomUUID()}`;
      const state = registerProcess(session, processId, handle, pendingOutput);
      outputListener = (entry) => appendEvent(session, { processId, type: entry.stream, data: entry.line });
      exitListener = (exit) => settleProcess(session, state, exit);
      if (pendingExit) settleProcess(session, state, pendingExit);
      return state.record;
    },

    async operateProcess(processId: string, input: ZelavisEnvironmentOperationInput): Promise<ZelavisEnvironmentOperationResult> {
      const process = processes.get(processId);
      if (!process) throw new Error(`Environment process ${processId} is not attached.`);
      let accepted = false;
      if (input.type === "stdin") {
        if (typeof input.data !== "string") throw new Error("Process stdin requires data.");
        accepted = process.handle.write ? await process.handle.write(input.data) : false;
      } else if (input.type === "signal") {
        if (!input.data || !ALLOWED_SIGNALS.has(input.data)) throw new Error("Process signal is not allowed.");
        accepted = process.handle.signal ? await process.handle.signal(input.data) : false;
      } else {
        if (process.handle.running) await process.handle.stop();
        accepted = true;
      }
      return { accepted, process: process.record };
    },

    async readEvents(sessionId: string, readOptions: ZelavisEnvironmentEventReadOptions = {}): Promise<ZelavisEnvironmentEventPage> {
      const session = requireSession(sessionId);
      const suppliedCursor = readOptions.after;
      const parsedAfter = suppliedCursor === undefined ? 0 : cursorSequence(suppliedCursor, session);
      const after = parsedAfter ?? 0;
      const limit = Math.max(1, Math.floor(readOptions.limit ?? DEFAULT_EVENT_LIMIT));
      const truncated = parsedAfter === undefined || after < session.droppedThrough || after >= session.nextSequence;
      const effectiveAfter = truncated ? session.droppedThrough : after;
      const available = session.events.filter((event) => (cursorSequence(event.cursor, session) ?? 0) > effectiveAfter);
      const events = available.slice(0, limit);
      return {
        events,
        cursor: events.at(-1)?.cursor ?? (truncated ? eventCursor(session, session.droppedThrough) : suppliedCursor),
        hasMore: available.length > events.length,
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}
