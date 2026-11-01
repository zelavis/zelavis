import { integration, integrationValue, unwrapFailure, unwrapIntegrationResult, presentProtocol, IntegrationFailure, present } from "../core/runtime/effect-boundary.js";
import { Cause, Effect } from "effect";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreRecord,
  ZelavisSystemStoreValue,
} from "../system-store.js";

const EDGE_NAMESPACE = "edge";
const POLICY_KEY = "policy";
const ACTIVE_SWITCH_KEY = "active-switch";

export type ZelavisEdgeCapability =
  | "http"
  | "https"
  | "tcp"
  | "udp"
  | "websocket"
  | "sse"
  | "http3"
  | "active-health-checks"
  | "weighted-targets"
  | "connection-draining"
  | "certificate-hot-reload";

export type ZelavisEdgeAdapterState =
  | "available"
  | "unavailable"
  | "unhealthy";

export interface ZelavisEdgeAdapterDetection {
  state: ZelavisEdgeAdapterState;
  installed: boolean;
  healthy: boolean;
  checkedAt: string;
  version?: string;
  detail?: string;
}

/**
 * Immutable reference to a canonical Edge publication owned by the Platform.
 *
 * Adapters compile this publication into their own derived configuration. The
 * proxy's config files are deliberately not the source of truth.
 */
export interface ZelavisEdgePublication {
  id: string;
  revision: string;
  routeCount: number;
  requiredCapabilities: readonly ZelavisEdgeCapability[];
  /** Opaque references only. Certificate bytes never belong in System Store. */
  certificateRefs: readonly string[];
}

export interface ZelavisEdgeAdapterContext {
  switchId: string;
  publication: ZelavisEdgePublication;
  previousAdapterId?: string;
}

export interface ZelavisEdgeAdapterVerification {
  ready: boolean;
  detail?: string;
}

/**
 * A reverse-proxy implementation behind Zelavis Edge.
 *
 * Every mutation must be idempotent for a switchId because a durable switch
 * can be resumed after the Platform restarts or a store CAS is retried.
 */
export interface ZelavisEdgeAdapter {
  id: string;
  title: string;
  capabilities: readonly ZelavisEdgeCapability[];
  detect(): Promise<ZelavisEdgeAdapterDetection>;
  stage(context: ZelavisEdgeAdapterContext): Promise<void>;
  verify(
    context: ZelavisEdgeAdapterContext,
  ): Promise<ZelavisEdgeAdapterVerification>;
  activate(context: ZelavisEdgeAdapterContext): Promise<void>;
  drain?(context: ZelavisEdgeAdapterContext): Promise<void>;
  rollback?(context: ZelavisEdgeAdapterContext): Promise<void>;
}

export interface ZelavisEdgeCertificateDistributor {
  /** Stage referenced material without making it authoritative for traffic. */
  stage(context: ZelavisEdgeAdapterContext): Promise<void>;
  /** Make the already-staged material readable by the target adapter. */
  activate(context: ZelavisEdgeAdapterContext): Promise<void>;
  rollback?(context: ZelavisEdgeAdapterContext): Promise<void>;
}

export type ZelavisEdgeSwitchPhase =
  | "preflight"
  | "stage-certificates"
  | "stage-routing"
  | "verify"
  | "activate-certificates"
  | "activate-routing"
  | "drain"
  | "commit"
  | "rollback"
  | "complete"
  | "failed";

export interface ZelavisEdgeSwitchRecord {
  schemaVersion: 1;
  id: string;
  targetAdapterId: string;
  previousAdapterId?: string;
  publication: ZelavisEdgePublication;
  phase: ZelavisEdgeSwitchPhase;
  startedAt: string;
  updatedAt: string;
  error?: string;
  fenceToken?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

export interface ZelavisEdgeReconciliationResult {
  status: "idle" | "resumed" | "recovered-forward" | "rolled-back";
  switchId?: string;
  phase?: ZelavisEdgeSwitchPhase;
  detail?: string;
}

export interface ZelavisEdgePolicy {
  schemaVersion: 1;
  revision: number;
  desiredAdapterId: string;
  activeAdapterId?: string;
  activePublication?: Pick<ZelavisEdgePublication, "id" | "revision">;
  updatedAt: string;
}

export interface ZelavisEdgeSwitchPlan {
  targetAdapterId: string;
  previousAdapterId?: string;
  publication: ZelavisEdgePublication;
  missingCapabilities: readonly ZelavisEdgeCapability[];
  detection: ZelavisEdgeAdapterDetection;
  ready: boolean;
}

export interface ZelavisEdgeAdapterStatus {
  id: string;
  title: string;
  capabilities: readonly ZelavisEdgeCapability[];
  detection: ZelavisEdgeAdapterDetection;
  active: boolean;
  desired: boolean;
}

export interface ZelavisEdgeManager {
  getPolicy(): Promise<ZelavisEdgePolicy>;
  listAdapters(): Promise<readonly ZelavisEdgeAdapterStatus[]>;
  getActiveSwitch(): Promise<ZelavisEdgeSwitchRecord | undefined>;
  planSwitch(
    targetAdapterId: string,
    publication: ZelavisEdgePublication,
  ): Promise<ZelavisEdgeSwitchPlan>;
  switchAdapter(
    targetAdapterId: string,
    publication: ZelavisEdgePublication,
  ): Promise<ZelavisEdgeSwitchRecord>;
  reconcile(): Promise<ZelavisEdgeReconciliationResult>;
}

export interface CreateZelavisEdgeManagerOptions {
  store: ZelavisSystemStore;
  adapters: readonly ZelavisEdgeAdapter[];
  defaultAdapterId: string;
  certificates: ZelavisEdgeCertificateDistributor;
  now?: () => Date;
  createSwitchId?: () => string;
  controllerId?: string;
  leaseDurationMs?: number;
  getPublication?: () => Promise<ZelavisEdgePublication | undefined>;
}

export class ZelavisEdgeValidationError extends Error {
  readonly code = "ZELAVIS_EDGE_VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "ZelavisEdgeValidationError";
  }
}

export class ZelavisEdgeConflictError extends Error {
  readonly code = "ZELAVIS_EDGE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ZelavisEdgeConflictError";
  }
}

export class ZelavisEdgeSwitchError extends Error {
  readonly code = "ZELAVIS_EDGE_SWITCH_FAILED";
  readonly record: ZelavisEdgeSwitchRecord;

  constructor(record: ZelavisEdgeSwitchRecord, cause: unknown) {
    super(
      `Edge switch "${record.id}" failed during ${record.phase}: ${errorMessage(cause)}.`,
      { cause },
    );
    this.name = "ZelavisEdgeSwitchError";
    this.record = record;
  }
}

function normalizedId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(normalized)) {
    throw new ZelavisEdgeValidationError(
      `${label} must contain 1-64 lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

function normalizedRevision(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new ZelavisEdgeValidationError(
      "Edge publication revision must contain 1-256 characters.",
    );
  }
  return normalized;
}

function normalizePublication(
  publication: ZelavisEdgePublication,
): ZelavisEdgePublication {
  if (!Number.isSafeInteger(publication.routeCount) || publication.routeCount < 0) {
    throw new ZelavisEdgeValidationError(
      "Edge publication routeCount must be a non-negative safe integer.",
    );
  }
  return {
    id: normalizedId(publication.id, "Edge publication id"),
    revision: normalizedRevision(publication.revision),
    routeCount: publication.routeCount,
    requiredCapabilities: [...new Set(publication.requiredCapabilities)].sort(),
    certificateRefs: publication.certificateRefs.map((reference) => {
      const normalized = reference.trim();
      if (!normalized || normalized.length > 512) {
        throw new ZelavisEdgeValidationError(
          "Edge certificate references must contain 1-512 characters.",
        );
      }
      return normalized;
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPublication(value: unknown): ZelavisEdgePublication {
  if (!isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.revision !== "string" ||
      typeof value.routeCount !== "number" ||
      !Array.isArray(value.requiredCapabilities) ||
      !value.requiredCapabilities.every((item) => typeof item === "string") ||
      !Array.isArray(value.certificateRefs) ||
      !value.certificateRefs.every((item) => typeof item === "string")) {
    throw new ZelavisEdgeValidationError("Stored Edge publication is invalid.");
  }
  return normalizePublication({
    id: value.id,
    revision: value.revision,
    routeCount: value.routeCount,
    requiredCapabilities: value.requiredCapabilities as ZelavisEdgeCapability[],
    certificateRefs: value.certificateRefs,
  });
}

function readPolicy(value: unknown): ZelavisEdgePolicy {
  if (!isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.revision !== "number" ||
      typeof value.desiredAdapterId !== "string" ||
      typeof value.updatedAt !== "string") {
    throw new ZelavisEdgeValidationError("Stored Edge policy is invalid.");
  }
  const activePublication = value.activePublication;
  if (activePublication !== undefined &&
      (!isRecord(activePublication) ||
       typeof activePublication.id !== "string" ||
       typeof activePublication.revision !== "string")) {
    throw new ZelavisEdgeValidationError(
      "Stored Edge policy publication is invalid.",
    );
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    desiredAdapterId: normalizedId(value.desiredAdapterId, "Edge adapter id"),
    ...(typeof value.activeAdapterId === "string"
      ? { activeAdapterId: normalizedId(value.activeAdapterId, "Edge adapter id") }
      : {}),
    ...(activePublication && isRecord(activePublication)
      ? {
          activePublication: {
            id: normalizedId(String(activePublication.id), "Edge publication id"),
            revision: normalizedRevision(String(activePublication.revision)),
          },
        }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function readSwitch(value: unknown): ZelavisEdgeSwitchRecord {
  if (!isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      typeof value.targetAdapterId !== "string" ||
      typeof value.phase !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.updatedAt !== "string") {
    throw new ZelavisEdgeValidationError("Stored Edge switch is invalid.");
  }
  const phases: readonly ZelavisEdgeSwitchPhase[] = [
    "preflight",
    "stage-certificates",
    "stage-routing",
    "verify",
    "activate-certificates",
    "activate-routing",
    "drain",
    "commit",
    "rollback",
    "complete",
    "failed",
  ];
  if (!phases.includes(value.phase as ZelavisEdgeSwitchPhase)) {
    throw new ZelavisEdgeValidationError("Stored Edge switch phase is invalid.");
  }
  return {
    schemaVersion: 1,
    id: value.id,
    targetAdapterId: normalizedId(
      value.targetAdapterId,
      "Edge target adapter id",
    ),
    ...(typeof value.previousAdapterId === "string"
      ? {
          previousAdapterId: normalizedId(
            value.previousAdapterId,
            "Edge previous adapter id",
          ),
        }
      : {}),
    publication: readPublication(value.publication),
    phase: value.phase as ZelavisEdgeSwitchPhase,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.fenceToken === "number" ? { fenceToken: value.fenceToken } : {}),
    ...(typeof value.leaseOwner === "string" ? { leaseOwner: value.leaseOwner } : {}),
    ...(typeof value.leaseExpiresAt === "string" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
  };
}

function storeValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}

function defaultSwitchId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `edge-${Date.now().toString(36)}-${random}`;
}

export function createZelavisEdgeManager(
  options: CreateZelavisEdgeManagerOptions,
): ZelavisEdgeManager {
  const now = options.now ?? (() => new Date());
  const createSwitchId = options.createSwitchId ?? defaultSwitchId;
  const defaultAdapterId = normalizedId(
    options.defaultAdapterId,
    "Default Edge adapter id",
  );
  const adapters = new Map<string, ZelavisEdgeAdapter>();
  for (const adapter of options.adapters) {
    const id = normalizedId(adapter.id, "Edge adapter id");
    if (adapters.has(id)) {
      throw new ZelavisEdgeValidationError(
        `Edge adapter "${id}" is registered more than once.`,
      );
    }
    adapters.set(id, { ...adapter, id });
  }
  if (!adapters.has(defaultAdapterId)) {
    throw new ZelavisEdgeValidationError(
      `Default Edge adapter "${defaultAdapterId}" is not registered.`,
    );
  }

  const timestamp = () => now().toISOString();
  const controllerId =
    options.controllerId ?? `ctrl-${Math.random().toString(36).slice(2, 10)}`;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const leaseExpiresAt = () =>
    new Date(now().getTime() + leaseDurationMs).toISOString();

  let localSwitch: Promise<ZelavisEdgeSwitchRecord> | undefined;

  const initialPolicy = (): ZelavisEdgePolicy => ({
    schemaVersion: 1,
    revision: 0,
    desiredAdapterId: defaultAdapterId,
    updatedAt: timestamp(),
  });

  function policyRecord(): Promise<ZelavisSystemStoreRecord> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisSystemStoreRecord, IntegrationFailure> {
    const existing = (yield* integrationValue(options.store.get(EDGE_NAMESPACE, POLICY_KEY)));
    if (existing) {
      readPolicy(existing.value);
      return existing;
    }
    return ((yield* integrationValue(options.store.setIfAbsent(
      EDGE_NAMESPACE,
      POLICY_KEY,
      storeValue(initialPolicy()),
    )))).record;
  }));
  }

  function writePolicy(
    targetAdapterId: string,
    publication: ZelavisEdgePublication,
  ): Promise<ZelavisEdgePolicy> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgePolicy, IntegrationFailure> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const currentRecord = (yield* integrationValue(policyRecord()));
      const current = readPolicy(currentRecord.value);
      const next: ZelavisEdgePolicy = {
        schemaVersion: 1,
        revision: current.revision + 1,
        desiredAdapterId: targetAdapterId,
        activeAdapterId: targetAdapterId,
        activePublication: {
          id: publication.id,
          revision: publication.revision,
        },
        updatedAt: timestamp(),
      };
      const written = (yield* integrationValue(options.store.compareAndSet(
        EDGE_NAMESPACE,
        POLICY_KEY,
        currentRecord.updatedAt,
        storeValue(next),
        currentRecord.value,
      )));
      if (written) return next;
    }
    throw new ZelavisEdgeConflictError(
      "Edge policy changed repeatedly while committing the adapter switch.",
    );
  }));
  }

  function persistSwitch(
    record: ZelavisSystemStoreRecord,
    current: ZelavisEdgeSwitchRecord,
    phase: ZelavisEdgeSwitchPhase,
    error?: string,
  ): Promise<{ store: ZelavisSystemStoreRecord; value: ZelavisEdgeSwitchRecord }> {
    return present(Effect.gen(function* (): Effect.fn.Return<{ store: ZelavisSystemStoreRecord; value: ZelavisEdgeSwitchRecord }, IntegrationFailure> {
    const next: ZelavisEdgeSwitchRecord = {
      ...current,
      phase,
      updatedAt: timestamp(),
      fenceToken: (current.fenceToken ?? 0) + 1,
      leaseOwner: controllerId,
      leaseExpiresAt: leaseExpiresAt(),
      ...(error ? { error } : {}),
    };
    const written = (yield* integrationValue(options.store.compareAndSet(
      EDGE_NAMESPACE,
      ACTIVE_SWITCH_KEY,
      record.updatedAt,
      storeValue(next),
      record.value,
    )));
    if (!written) {
      throw new ZelavisEdgeConflictError(
        `Edge switch "${current.id}" was changed by another controller.`,
      );
    }
    (yield* integrationValue(options.store.set(
      EDGE_NAMESPACE,
      `switch:${next.id}`,
      storeValue(next),
    )));
    return { store: written, value: next };
  }));
  }

  function runSwitch(
    initialStore: ZelavisSystemStoreRecord,
    initial: ZelavisEdgeSwitchRecord,
  ): Promise<ZelavisEdgeSwitchRecord> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeSwitchRecord, IntegrationFailure> {
    let stored = initialStore;
    let operation = initial;
    const target = adapters.get(operation.targetAdapterId);
    if (!target) {
      throw new ZelavisEdgeValidationError(
        `Unknown Edge adapter "${operation.targetAdapterId}".`,
      );
    }
    const previous = operation.previousAdapterId
      ? adapters.get(operation.previousAdapterId)
      : undefined;
    const context: ZelavisEdgeAdapterContext = {
      switchId: operation.id,
      publication: operation.publication,
      ...(operation.previousAdapterId
        ? { previousAdapterId: operation.previousAdapterId }
        : {}),
    };

    const advance = (phase: ZelavisEdgeSwitchPhase) => Effect.gen(function* () {
      const next = (yield* integrationValue(persistSwitch(stored, operation, phase)));
      stored = next.store;
      operation = next.value;
    });

    return yield* Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeSwitchRecord, IntegrationFailure> {
      while (operation.phase !== "complete") {
        switch (operation.phase) {
          case "preflight": {
            const plan = yield* integrationValue(manager.planSwitch(
              operation.targetAdapterId,
              operation.publication,
            ));
            if (!plan.ready) {
              const reasons = [
                plan.detection.detail,
                plan.missingCapabilities.length
                  ? `missing capabilities: ${plan.missingCapabilities.join(", ")}`
                  : undefined,
              ].filter(Boolean).join("; ");
              throw new ZelavisEdgeValidationError(
                `Edge adapter "${target.id}" is not ready${reasons ? ` (${reasons})` : ""}.`,
              );
            }
            yield* advance("stage-certificates");
            break;
          }
          case "stage-certificates":
            yield* integration(() => options.certificates.stage(context));
            yield* advance("stage-routing");
            break;
          case "stage-routing":
            yield* integration(() => target.stage(context));
            yield* advance("verify");
            break;
          case "verify": {
            const verification = yield* integration(() => target.verify(context));
            if (!verification.ready) {
              throw new ZelavisEdgeValidationError(
                `Edge adapter "${target.id}" failed staged verification${verification.detail ? `: ${verification.detail}` : "."}`,
              );
            }
            yield* advance("activate-certificates");
            break;
          }
          case "activate-certificates":
            yield* integration(() => options.certificates.activate(context));
            yield* advance("activate-routing");
            break;
          case "activate-routing": {
            if (options.getPublication) {
              const currentPub = yield* integration(() => options.getPublication!());
              if (
                currentPub &&
                (currentPub.id !== operation.publication.id ||
                  currentPub.revision !== operation.publication.revision)
              ) {
                throw new ZelavisEdgeValidationError(
                  `Edge switch "${operation.id}" publication revision "${operation.publication.revision}" was superseded by "${currentPub.revision}".`,
                );
              }
            }
            yield* integration(() => target.activate(context));
            yield* advance("drain");
            break;
          }
          case "drain":
            if (previous && previous.id !== target.id) {
              yield* integration(() => previous.drain?.(context));
            }
            yield* advance("commit");
            break;
          case "commit":
            yield* integrationValue(writePolicy(target.id, operation.publication));
            yield* advance("complete");
            break;
          case "rollback":
          case "failed":
            throw new ZelavisEdgeConflictError(
              `Edge switch "${operation.id}" cannot resume from ${operation.phase}.`,
            );
          default: {
            const exhaustive: never = operation.phase;
            throw new Error(`Unhandled Edge switch phase: ${exhaustive}`);
          }
        }
      }
      return operation;
    }).pipe(Effect.catchCause((failure) => Effect.gen(function* () {
      let cause = unwrapFailure(Cause.squash(failure));
      if (cause instanceof ZelavisEdgeConflictError) {
        throw cause;
      }
      const failedPhase = operation.phase;
      const rollbackFailure = yield* Effect.gen(function* () {
        const rollingBack = yield* integrationValue(persistSwitch(
          stored,
          operation,
          "rollback",
          errorMessage(cause),
        ));
        stored = rollingBack.store;
        operation = rollingBack.value;
        yield* integration(() => target.rollback?.(context));
        yield* integration(() => options.certificates.rollback?.(context));
      }).pipe(
        Effect.as(undefined),
        Effect.catchCause((rollbackCause) => Effect.succeed({ cause: unwrapFailure(Cause.squash(rollbackCause)) })),
      );
      if (rollbackFailure) {
        cause = new AggregateError(
          [cause, rollbackFailure.cause],
          `Edge switch failed during ${failedPhase}, then rollback failed.`,
        );
      }
      const failed = yield* integrationValue(persistSwitch(
        stored,
        operation,
        "failed",
        errorMessage(cause),
      ));
      throw new ZelavisEdgeSwitchError(failed.value, cause);
    })));
    }));
  }

  const manager: ZelavisEdgeManager = {
    getPolicy() {
    return present(Effect.gen(function* () {
      return (yield* integrationValue(readPolicy(((yield* integrationValue(policyRecord()))).value)));
    }));
  },
    listAdapters() {
      return present(Effect.gen(function* () {
        const policy = yield* integrationValue(manager.getPolicy());
        return yield* Effect.forEach(
          [...adapters.values()],
          (adapter) => Effect.gen(function* () {
            return {
              id: adapter.id,
              title: adapter.title,
              capabilities: [...adapter.capabilities],
              detection: yield* integration(() => adapter.detect()),
              active: policy.activeAdapterId === adapter.id,
              desired: policy.desiredAdapterId === adapter.id,
            };
          }),
          { concurrency: Math.max(1, adapters.size) },
        );
      }));
    },
    getActiveSwitch() {
    return present(Effect.gen(function* () {
      const record = (yield* integrationValue(options.store.get(EDGE_NAMESPACE, ACTIVE_SWITCH_KEY)));
      return record ? readSwitch(record.value) : undefined;
    }));
  },
    planSwitch(targetAdapterId, publication) {
    return present(Effect.gen(function* () {
      const id = normalizedId(targetAdapterId, "Edge adapter id");
      const adapter = adapters.get(id);
      if (!adapter) {
        throw new ZelavisEdgeValidationError(`Unknown Edge adapter "${id}".`);
      }
      const normalized = normalizePublication(publication);
      const policy = (yield* integrationValue(manager.getPolicy()));
      const detection = (yield* integrationValue(adapter.detect()));
      const capabilities = new Set(adapter.capabilities);
      const missingCapabilities = normalized.requiredCapabilities.filter(
        (capability) => !capabilities.has(capability),
      );
      return {
        targetAdapterId: id,
        ...(policy.activeAdapterId
          ? { previousAdapterId: policy.activeAdapterId }
          : {}),
        publication: normalized,
        missingCapabilities,
        detection,
        ready:
          detection.state === "available" &&
          detection.installed &&
          detection.healthy &&
          missingCapabilities.length === 0,
      };
    }));
  },
    switchAdapter(targetAdapterId, publication) {
      return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeSwitchRecord, IntegrationFailure> {
      if (localSwitch) {
        throw new ZelavisEdgeConflictError(
          "Another Edge adapter switch is already running in this controller.",
        );
      }
      const id = normalizedId(targetAdapterId, "Edge adapter id");
      const normalized = normalizePublication(publication);
      const policy = yield* integrationValue(manager.getPolicy());
      const current = yield* integrationValue(options.store.get(EDGE_NAMESPACE, ACTIVE_SWITCH_KEY));
      if (current) {
        const existing = readSwitch(current.value);
        if (existing.phase !== "complete" && existing.phase !== "failed") {
          const nowTime = now().getTime();
          const leaseActive =
            existing.leaseExpiresAt &&
            new Date(existing.leaseExpiresAt).getTime() > nowTime;
          if (
            leaseActive &&
            existing.leaseOwner &&
            existing.leaseOwner !== controllerId
          ) {
            throw new ZelavisEdgeConflictError(
              `Edge switch "${existing.id}" is leased to controller "${existing.leaseOwner}" until ${existing.leaseExpiresAt}.`,
            );
          }
          if (
            existing.targetAdapterId !== id ||
            existing.publication.id !== normalized.id ||
            existing.publication.revision !== normalized.revision
          ) {
            if (leaseActive) {
              throw new ZelavisEdgeConflictError(
                `Edge switch "${existing.id}" is already running for adapter "${existing.targetAdapterId}".`,
              );
            }
            // Stale/expired switch targeting a different adapter or revision.
            // Reconcile it first to clean up or forward-recover.
            yield* integrationValue(manager.reconcile());
            const refreshed = yield* integrationValue(options.store.get(
              EDGE_NAMESPACE,
              ACTIVE_SWITCH_KEY,
            ));
            if (refreshed) {
              const refreshedSwitch = readSwitch(refreshed.value);
              if (
                refreshedSwitch.phase !== "complete" &&
                refreshedSwitch.phase !== "failed"
              ) {
                throw new ZelavisEdgeConflictError(
                  `Previous incomplete Edge switch "${refreshedSwitch.id}" could not be reconciled.`,
                );
              }
            }
          } else {
            // Same switch request: claim lease and resume execution.
            const claimedNext: ZelavisEdgeSwitchRecord = {
              ...existing,
              fenceToken: (existing.fenceToken ?? 0) + 1,
              leaseOwner: controllerId,
              leaseExpiresAt: leaseExpiresAt(),
              updatedAt: timestamp(),
            };
            const written = yield* integrationValue(options.store.compareAndSet(
              EDGE_NAMESPACE,
              ACTIVE_SWITCH_KEY,
              current.updatedAt,
              storeValue(claimedNext),
              current.value,
            ));
            if (!written) {
              throw new ZelavisEdgeConflictError(
                `Edge switch "${existing.id}" was claimed by another controller.`,
              );
            }
            localSwitch = runSwitch(written, claimedNext);
            return yield* integrationValue(localSwitch).pipe(
              Effect.ensuring(Effect.sync(() => { localSwitch = undefined; })),
            );
          }
        }
      }

      const startedAt = timestamp();
      const operation: ZelavisEdgeSwitchRecord = {
        schemaVersion: 1,
        id: createSwitchId(),
        targetAdapterId: id,
        ...(policy.activeAdapterId
          ? { previousAdapterId: policy.activeAdapterId }
          : {}),
        publication: normalized,
        phase: "preflight",
        startedAt,
        updatedAt: startedAt,
        fenceToken: 1,
        leaseOwner: controllerId,
        leaseExpiresAt: leaseExpiresAt(),
      };
      let claimed: ZelavisSystemStoreRecord;
      const latestCurrent = yield* integrationValue(options.store.get(
        EDGE_NAMESPACE,
        ACTIVE_SWITCH_KEY,
      ));
      if (!latestCurrent) {
        const result = yield* integrationValue(options.store.setIfAbsent(
          EDGE_NAMESPACE,
          ACTIVE_SWITCH_KEY,
          storeValue(operation),
        ));
        if (!result.created) {
          throw new ZelavisEdgeConflictError(
            "Another Edge adapter switch was started concurrently.",
          );
        }
        claimed = result.record;
      } else {
        const replaced = yield* integrationValue(options.store.compareAndSet(
          EDGE_NAMESPACE,
          ACTIVE_SWITCH_KEY,
          latestCurrent.updatedAt,
          storeValue(operation),
          latestCurrent.value,
        ));
        if (!replaced) {
          throw new ZelavisEdgeConflictError(
            "Another Edge adapter switch was started concurrently.",
          );
        }
        claimed = replaced;
      }
      yield* integrationValue(options.store.set(
        EDGE_NAMESPACE,
        `switch:${operation.id}`,
        storeValue(operation),
      ));
      localSwitch = runSwitch(claimed, operation);
      return yield* integrationValue(localSwitch).pipe(
        Effect.ensuring(Effect.sync(() => { localSwitch = undefined; })),
      );
      }));
    },
    reconcile(): Promise<ZelavisEdgeReconciliationResult> { return presentProtocol(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeReconciliationResult, IntegrationFailure> {
      if (localSwitch) {
        return { status: "idle", detail: "Switch is currently running locally" };
      }
      const record = (yield* integrationValue(options.store.get(EDGE_NAMESPACE, ACTIVE_SWITCH_KEY)));
      if (!record) {
        return { status: "idle" };
      }
      const existing = readSwitch(record.value);
      if (existing.phase === "complete" || existing.phase === "failed") {
        return { status: "idle", switchId: existing.id, phase: existing.phase };
      }
      const nowTime = now().getTime();
      const leaseActive =
        existing.leaseExpiresAt &&
        new Date(existing.leaseExpiresAt).getTime() > nowTime;
      if (
        leaseActive &&
        existing.leaseOwner &&
        existing.leaseOwner !== controllerId
      ) {
        return {
          status: "idle",
          switchId: existing.id,
          phase: existing.phase,
          detail: `Active switch leased to controller "${existing.leaseOwner}" until ${existing.leaseExpiresAt}`,
        };
      }

      // Claim the lease via CAS to recover the interrupted switch
      const claimed: ZelavisEdgeSwitchRecord = {
        ...existing,
        fenceToken: (existing.fenceToken ?? 0) + 1,
        leaseOwner: controllerId,
        leaseExpiresAt: leaseExpiresAt(),
        updatedAt: timestamp(),
      };
      const claimedRecord = (yield* integrationValue(options.store.compareAndSet(
        EDGE_NAMESPACE,
        ACTIVE_SWITCH_KEY,
        record.updatedAt,
        storeValue(claimed),
        record.value,
      )));
      if (!claimedRecord) {
        return {
          status: "idle",
          switchId: existing.id,
          phase: existing.phase,
          detail: "Failed to claim switch for recovery due to concurrent update",
        };
      }

      const target = adapters.get(claimed.targetAdapterId);
      const previous = claimed.previousAdapterId
        ? adapters.get(claimed.previousAdapterId)
        : undefined;
      const context: ZelavisEdgeAdapterContext = {
        switchId: claimed.id,
        publication: claimed.publication,
        ...(claimed.previousAdapterId
          ? { previousAdapterId: claimed.previousAdapterId }
          : {}),
      };

      // Case 1: Pre-traffic activation ("preflight", "stage-certificates", "stage-routing", "verify", "activate-certificates")
      const preTrafficPhases: readonly ZelavisEdgeSwitchPhase[] = [
        "preflight",
        "stage-certificates",
        "stage-routing",
        "verify",
        "activate-certificates",
      ];
      if (preTrafficPhases.includes(claimed.phase)) {
        if (target?.rollback) {
          (yield* integrationValue(target.rollback(context)));
        }
        if (options.certificates.rollback) {
          (yield* integrationValue(options.certificates.rollback(context)));
        }
        const failed = (yield* integrationValue(persistSwitch(
          claimedRecord,
          claimed,
          "failed",
          "Interrupted by controller restart before traffic activation",
        )));
        return {
          status: "rolled-back",
          switchId: failed.value.id,
          phase: "failed",
          detail:
            "Rolled back candidate configuration before traffic activation",
        };
      }

      // Case 2: Post-traffic activation ("activate-routing", "drain", "commit")
      const postTrafficPhases: readonly ZelavisEdgeSwitchPhase[] = [
        "activate-routing",
        "drain",
        "commit",
      ];
      if (postTrafficPhases.includes(claimed.phase)) {
        let isHealthy = false;
        if (target) {
          try {
            const verification = unwrapIntegrationResult(yield* Effect.result(integrationValue(target.verify(context))));
            isHealthy = verification.ready;
          } catch {
            isHealthy = false;
          }
        }
        if (isHealthy && target) {
          // Forward recovery: target adapter is healthy, complete the switch!
          if (previous && previous.id !== target.id && previous.drain) {
            (yield* integrationValue(previous.drain(context)));
          }
          (yield* integrationValue(writePolicy(target.id, claimed.publication)));
          const completed = (yield* integrationValue(persistSwitch(
            claimedRecord,
            claimed,
            "complete",
          )));
          return {
            status: "recovered-forward",
            switchId: completed.value.id,
            phase: "complete",
            detail:
              "Target adapter healthy; completed cutover and committed policy",
          };
        } else {
          // Backward recovery: Target unhealthy, roll back to previous adapter.
          if (target?.rollback) {
            (yield* integrationValue(target.rollback(context)));
          }
          if (options.certificates.rollback) {
            (yield* integrationValue(options.certificates.rollback(context)));
          }
          if (previous?.activate) {
            (yield* integrationValue(previous.activate(context)));
          }
          const failed = (yield* integrationValue(persistSwitch(
            claimedRecord,
            claimed,
            "failed",
            "Interrupted cutover failed target verification during recovery; rolled back",
          )));
          return {
            status: "rolled-back",
            switchId: failed.value.id,
            phase: "failed",
            detail:
              "Target adapter unhealthy during recovery; rolled back to previous adapter",
          };
        }
      }

      // Case 3: Already in rollback
      if (claimed.phase === "rollback") {
        if (target?.rollback) {
          (yield* integrationValue(target.rollback(context)));
        }
        if (options.certificates.rollback) {
          (yield* integrationValue(options.certificates.rollback(context)));
        }
        const failed = (yield* integrationValue(persistSwitch(
          claimedRecord,
          claimed,
          "failed",
          "Incomplete rollback finalized during recovery",
        )));
        return {
          status: "rolled-back",
          switchId: failed.value.id,
          phase: "failed",
          detail: "Rollback finalized",
        };
      }

      return {
        status: "idle",
        switchId: claimed.id,
        phase: claimed.phase,
      };
    }).pipe(Effect.withSpan("createZelavisEdgeManager/manager/reconcile"))); },
  };

  return manager;
}

export * from "./routes.js";
export * from "./traefik-compiler.js";
export * from "./traefik-adapter.js";
export * from "./onboarding.js";
export * from "./acme-crypto.js";
export * from "./acme-client.js";
export * from "./certificates.js";
export { createZelavisEdgePreviews } from "./previews.js";
export type { ZelavisEdgePreviews, ZelavisEdgePreviewHost, ZelavisProjectPreview } from "./previews.js";
