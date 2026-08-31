import type {
  ZelavisAgentIdentity,
  ZelavisAgentOperationEvent,
  ZelavisAgentOperationManager,
  ZelavisAgentOperationManagerOptions,
  ZelavisAgentOperationStatus,
  ZelavisAgentOperationSummary,
} from "../core/agent/index.js";
import type {
  ZelavisHostOperationRequest,
  ZelavisHostOperationResult,
} from "../core/deployment/index.js";
import { validateHostOperationRequestShape } from "../core/deployment/index.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreRecord,
  ZelavisSystemStoreValue,
} from "../system-store.js";

const IDENTITY_NAMESPACE = "agent";
const IDENTITY_KEY = "identity";
const OPERATIONS_NAMESPACE = "agent-operations";
const FINAL_AUTHORITY = "redacted-after-execution";

interface StoredAgentOperation {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly fingerprint: string;
  readonly request: ZelavisHostOperationRequest;
  readonly status: ZelavisAgentOperationStatus;
  readonly attempts: number;
  readonly lease?: {
    readonly ownerId: string;
    readonly expiresAt: string;
  };
  readonly result?: Pick<
    ZelavisHostOperationResult,
    "exitCode" | "startedAt" | "finishedAt"
  >;
  readonly events: readonly ZelavisAgentOperationEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ZelavisAgentOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisAgentOperationConflictError";
  }
}

function storeValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}

function parseStoredOperation(record: ZelavisSystemStoreRecord): StoredAgentOperation {
  const value = record.value as unknown as StoredAgentOperation;
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    typeof value.agentId !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.request?.operationId !== "string" ||
    !["queued", "running", "succeeded", "failed"].includes(value.status) ||
    !Array.isArray(value.events)
  ) {
    throw new TypeError(`Stored Agent operation "${record.key}" is invalid.`);
  }
  return value;
}

function toSummary(operation: StoredAgentOperation): ZelavisAgentOperationSummary {
  return {
    operationId: operation.request.operationId,
    agentId: operation.agentId,
    operation: operation.request.operation,
    version: operation.request.version,
    artifactDigest: operation.request.artifactDigest,
    ...(operation.request.projectId ? { projectId: operation.request.projectId } : {}),
    status: operation.status,
    attempts: operation.attempts,
    ...(operation.lease ? { leaseExpiresAt: operation.lease.expiresAt } : {}),
    ...(operation.result
      ? {
          exitCode: operation.result.exitCode,
          startedAt: operation.result.startedAt,
          finishedAt: operation.result.finishedAt,
        }
      : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    events: operation.events,
  };
}

async function requestFingerprint(request: ZelavisHostOperationRequest): Promise<string> {
  const body = JSON.stringify([
    request.operation,
    request.version,
    request.artifactDigest,
    Object.entries(request.arguments).sort(([left], [right]) => left.localeCompare(right)),
    request.projectId ?? null,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function appendEvent(
  operation: StoredAgentOperation,
  type: ZelavisAgentOperationEvent["type"],
  ownerId?: string,
): readonly ZelavisAgentOperationEvent[] {
  return [
    ...operation.events,
    {
      sequence: (operation.events.at(-1)?.sequence ?? 0) + 1,
      type,
      timestamp: new Date().toISOString(),
      ...(ownerId ? { ownerId } : {}),
    },
  ];
}

async function resolveIdentity(store: ZelavisSystemStore): Promise<ZelavisAgentIdentity> {
  const now = new Date().toISOString();
  const created = await store.setIfAbsent(IDENTITY_NAMESPACE, IDENTITY_KEY, {
    id: crypto.randomUUID(),
    createdAt: now,
  });
  const value = created.record.value as unknown as ZelavisAgentIdentity;
  if (!value || typeof value.id !== "string" || typeof value.createdAt !== "string") {
    throw new TypeError("Stored Agent identity is invalid.");
  }
  return Object.freeze({ id: value.id, createdAt: value.createdAt });
}

/**
 * Creates the durable local Agent journal. The caller should run this manager in
 * a separately supervised Agent process; no Platform route can submit commands.
 */
export async function createAgentOperationManager(options: {
  readonly store: ZelavisSystemStore;
} & ZelavisAgentOperationManagerOptions): Promise<ZelavisAgentOperationManager> {
  const identity = await resolveIdentity(options.store);
  const ownerId = `${identity.id}:${crypto.randomUUID()}`;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 32));
  const discoveryLimit = Math.max(1, Math.min(options.discoveryLimit ?? 100, 1_000));
  const pending: string[] = [];
  const pendingSet = new Set<string>();
  const active = new Set<Promise<void>>();
  const idleWaiters = new Set<() => void>();
  let closed = false;

  function notifyIdle() {
    if (active.size > 0 || pending.length > 0) return;
    for (const resolveIdle of idleWaiters) resolveIdle();
    idleWaiters.clear();
  }

  function waitForIdle(): Promise<void> {
    if (active.size === 0 && pending.length === 0) return Promise.resolve();
    return new Promise((resolveIdle) => idleWaiters.add(resolveIdle));
  }

  async function claim(operationId: string): Promise<StoredAgentOperation | undefined> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await options.store.get(OPERATIONS_NAMESPACE, operationId);
      if (!record) return undefined;
      const operation = parseStoredOperation(record);
      const expired = operation.status === "running" &&
        Date.parse(operation.lease?.expiresAt ?? "") <= Date.now();
      if (operation.status !== "queued" && !expired) return undefined;
      const updatedAt = new Date().toISOString();
      const next: StoredAgentOperation = {
        ...operation,
        status: "running",
        attempts: operation.attempts + 1,
        lease: {
          ownerId,
          expiresAt: new Date(
            Math.max(Date.parse(operation.request.deadline), Date.now() + 1_000) + 60_000,
          ).toISOString(),
        },
        events: appendEvent(operation, expired ? "recovered" : "claimed", ownerId),
        updatedAt,
      };
      const changed = await options.store.compareAndSet(
        OPERATIONS_NAMESPACE,
        operationId,
        record.updatedAt,
        storeValue(next),
      );
      if (changed) return next;
    }
    return undefined;
  }

  async function finish(
    operation: StoredAgentOperation,
    result?: ZelavisHostOperationResult,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await options.store.get(
        OPERATIONS_NAMESPACE,
        operation.request.operationId,
      );
      if (!record) return;
      const current = parseStoredOperation(record);
      if (current.status !== "running" || current.lease?.ownerId !== ownerId) return;
      const succeeded = result?.status === "succeeded";
      const updatedAt = new Date().toISOString();
      const next: StoredAgentOperation = {
        ...current,
        request: { ...current.request, authority: FINAL_AUTHORITY },
        status: succeeded ? "succeeded" : "failed",
        lease: undefined,
        ...(result
          ? {
              result: {
                exitCode: result.exitCode,
                startedAt: result.startedAt,
                finishedAt: result.finishedAt,
              },
            }
          : {}),
        events: appendEvent(current, succeeded ? "succeeded" : "failed", ownerId),
        updatedAt,
      };
      if (await options.store.compareAndSet(
        OPERATIONS_NAMESPACE,
        current.request.operationId,
        record.updatedAt,
        storeValue(next),
      )) return;
    }
  }

  async function execute(operationId: string): Promise<void> {
    const operation = await claim(operationId);
    if (!operation) return;
    try {
      const result = await options.executor.execute(operation.request);
      await finish(operation, result);
    } catch {
      await finish(operation);
    }
  }

  function drain() {
    while (!closed && active.size < concurrency && pending.length > 0) {
      const operationId = pending.shift();
      if (!operationId) break;
      pendingSet.delete(operationId);
      const running = execute(operationId).finally(() => {
        active.delete(running);
        drain();
        notifyIdle();
      });
      active.add(running);
    }
    notifyIdle();
  }

  function schedule(operationId: string) {
    if (closed || pendingSet.has(operationId)) return;
    pendingSet.add(operationId);
    pending.push(operationId);
    drain();
  }

  return {
    identity,
    async get(operationId) {
      const record = await options.store.get(OPERATIONS_NAMESPACE, operationId);
      return record ? toSummary(parseStoredOperation(record)) : undefined;
    },
    async list(listOptions = {}) {
      const limit = Math.max(1, Math.min(listOptions.limit ?? 100, 500));
      return (await options.store.list(OPERATIONS_NAMESPACE))
        .map(parseStoredOperation)
        .filter((operation) =>
          listOptions.status ? operation.status === listOptions.status : true
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map(toSummary);
    },
    async submit(request) {
      if (closed) throw new Error("Agent operation manager is closed.");
      validateHostOperationRequestShape(request);
      const fingerprint = await requestFingerprint(request);
      const now = new Date().toISOString();
      const operation: StoredAgentOperation = {
        schemaVersion: 1,
        agentId: identity.id,
        fingerprint,
        request,
        status: "queued",
        attempts: 0,
        events: [{ sequence: 1, type: "submitted", timestamp: now }],
        createdAt: now,
        updatedAt: now,
      };
      const claimed = await options.store.setIfAbsent(
        OPERATIONS_NAMESPACE,
        request.operationId,
        storeValue(operation),
      );
      const stored = parseStoredOperation(claimed.record);
      if (!claimed.created && stored.fingerprint !== fingerprint) {
        throw new ZelavisAgentOperationConflictError(
          "Agent operation id was already used for a different request.",
        );
      }
      if (stored.status === "queued") schedule(request.operationId);
      return toSummary(stored);
    },
    async reconcile() {
      if (closed) throw new Error("Agent operation manager is closed.");
      const records = (await options.store.list(OPERATIONS_NAMESPACE))
        .map(parseStoredOperation)
        .filter((operation) =>
          operation.status === "queued" ||
          (operation.status === "running" &&
            Date.parse(operation.lease?.expiresAt ?? "") <= Date.now())
        )
        .slice(0, discoveryLimit);
      for (const operation of records) schedule(operation.request.operationId);
      await waitForIdle();
    },
    async close() {
      closed = true;
      pending.length = 0;
      pendingSet.clear();
      await waitForIdle();
    },
  };
}
