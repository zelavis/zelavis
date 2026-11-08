import { proposeBoundedLoadNode } from "../core/fabric/bounded-load.js";
import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "fabric.app-data-placement.v1";
const MAX_ID_LENGTH = 256;
const MAX_PLACEMENTS = 256;
const MAX_OPERATION_IDS = 4096;
const MAX_LEDGER_ROUNDS = 8;

/** Project deletion participant; idempotent after a stopped runtime. */
export function deleteAppShardPlacementLedger(
  store: ZelavisSystemStore,
  projectId: string,
): Promise<void> {
  return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    if (!validId(projectId)) throw new TypeError("Invalid Project id for shard placement cleanup");
    (yield* integrationValue(store.delete(NAMESPACE, projectId)));
  }));
}

export type AppShardPlacementState = "reserved" | "preparing" | "committed" | "releasing" | "released";
export type AppShardPlacementRole = "primary" | "replica";

export interface AppShardPlacementRequest {
  readonly protocolVersion: 1;
  readonly intent: "allocate" | "replica";
  readonly operationId: string;
  readonly projectId: string;
  readonly shardId: string;
  readonly of?: string;
  readonly virtualRanges: readonly number[];
  readonly mapVersion: number;
  /** Zero means that no placement record has yet been observed. */
  readonly expectedRevision: number;
  readonly resources: {
    readonly cpuCores: number;
    readonly memoryBytes: number;
    readonly diskBytes: number;
  };
  readonly durability: "crash" | "power";
}

export interface AppShardAllocation {
  readonly projectId: string;
  readonly generation: number;
  readonly allowedNodeIds: readonly string[];
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

export interface AppShardPlacementNode {
  readonly id: string;
  readonly ready: boolean;
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

/**
 * One shard's record in its Project's ledger. A `reserved` entry has no writer authority and is never a routable
 * target; `epoch` is 0 until the first activation and only rises afterwards, a released entry keeping it as the
 * shard's high-water.
 */
export interface AppShardPlacement {
  readonly protocolVersion: 1;
  readonly state: AppShardPlacementState;
  readonly operationId: string;
  readonly projectId: string;
  readonly incarnation: string;
  readonly shardId: string;
  readonly role: AppShardPlacementRole;
  readonly of?: string;
  readonly nodeId: string;
  readonly allocationGeneration: number;
  readonly mapVersion: number;
  readonly virtualRanges: readonly number[];
  readonly resources: AppShardPlacementRequest["resources"];
  readonly durability: "crash" | "power";
  readonly revision: number;
  readonly requestFingerprint: string;
  readonly epoch: number;
  readonly projectEpoch: number;
}

export type AppShardPlacementRefusal =
  | "invalid-request"
  | "foreign-project"
  | "allocation-unavailable"
  | "allocation-changed"
  | "out-of-envelope"
  | "no-eligible-node"
  | "range-conflict"
  | "revision-conflict"
  | "operation-conflict"
  | "shard-in-use"
  | "replica-exists"
  | "replica-live"
  | "unknown-shard"
  | "wrong-state"
  | "stale"
  | "ledger-full";

export type AppShardPlacementDecision =
  | { readonly granted: true; readonly placement: AppShardPlacement }
  | {
    readonly granted: false;
    readonly reason: AppShardPlacementRefusal;
    readonly currentRevision: number;
    readonly current?: AppShardPlacement;
  };

export interface AppShardPlacementLedgerView {
  /** Undefined when no ledger exists. */
  readonly incarnation: string | undefined;
  /** Zero when no ledger exists. */
  readonly revision: number;
  readonly placements: readonly AppShardPlacement[];
}

export interface AppShardPlacementAuthority {
  /** Caller identity comes from the authenticated Project channel, not request data. */
  readonly request: (callerProjectId: string, input: unknown, caller: { readonly nodeId: string }) => Promise<AppShardPlacementDecision>;
  readonly current: (projectId: string, shardId: string) => Promise<AppShardPlacement | undefined>;
  readonly list: (projectId: string) => Promise<AppShardPlacementLedgerView>;
  /** reserved → preparing, epoch + 1, projectEpoch set. The same operation already preparing or committed returns it. */
  readonly beginActivation: (input: {
    readonly projectId: string; readonly shardId: string; readonly operationId: string; readonly projectEpoch: number;
  }) => Promise<AppShardPlacementDecision>;
  /** preparing(epoch) → committed. Already committed at that epoch returns it. */
  readonly commitActivation: (input: {
    readonly projectId: string; readonly shardId: string; readonly operationId: string; readonly epoch: number;
  }) => Promise<AppShardPlacementDecision>;
  /** committed with a lower projectEpoch → committed, epoch + 1. Equal returns it; greater is `stale`. */
  readonly reissue: (input: {
    readonly projectId: string; readonly shardId: string; readonly projectEpoch: number;
  }) => Promise<AppShardPlacementDecision>;
  /** reserved → released; preparing | committed → releasing. Already releasing or released returns it. */
  readonly beginRelease: (input: {
    readonly projectId: string; readonly shardId: string; readonly operationId: string;
  }) => Promise<AppShardPlacementDecision>;
  /** releasing(epoch) → released. Already released at that epoch returns it. */
  readonly completeRelease: (input: {
    readonly projectId: string; readonly shardId: string; readonly epoch: number;
  }) => Promise<AppShardPlacementDecision>;
}

const STATES: readonly string[] = ["reserved", "preparing", "committed", "releasing", "released"];

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
  !/[\u0000-\u001f]/.test(value);
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => nonnegativeInteger(value) && value > 0;
const byCodePoint = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function validShardShape(
  role: unknown, shardId: string, of: unknown, ranges: unknown, resources: AppShardPlacementRequest["resources"],
): boolean {
  if (!Array.isArray(ranges) || !positiveInteger(resources.diskBytes)) return false;
  if (role === "replica") {
    return validId(of) && !of.endsWith(".replica") && shardId === `${of}.replica` && ranges.length === 0 &&
      nonnegativeInteger(resources.cpuCores) && nonnegativeInteger(resources.memoryBytes);
  }
  return role === "primary" && of === undefined && !shardId.endsWith(".replica") &&
    ranges.length > 0 && ranges.length <= 4096 && ranges.every(nonnegativeInteger) &&
    new Set(ranges).size === ranges.length && positiveInteger(resources.cpuCores) && positiveInteger(resources.memoryBytes);
}

function validRequest(value: unknown): value is AppShardPlacementRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AppShardPlacementRequest>;
  const resources = request.resources;
  const allowed = new Set(["protocolVersion", "intent", "operationId", "projectId", "shardId", "of", "virtualRanges", "mapVersion", "expectedRevision", "resources", "durability"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) ||
      !resources || typeof resources !== "object" || Array.isArray(resources) ||
      Object.keys(resources).some((key) => !["cpuCores", "memoryBytes", "diskBytes"].includes(key))) return false;
  return request.protocolVersion === 1 &&
    (request.intent === "allocate" || request.intent === "replica") &&
    validId(request.operationId) && validId(request.projectId) && validId(request.shardId) &&
    (request.durability === "crash" || request.durability === "power") &&
    positiveInteger(request.mapVersion) && nonnegativeInteger(request.expectedRevision) &&
    validShardShape(request.intent === "allocate" ? "primary" : "replica", request.shardId, request.of, request.virtualRanges, resources);
}

function validPlacement(value: unknown): value is AppShardPlacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const placement = value as Partial<AppShardPlacement>;
  const resources = placement.resources;
  return placement.protocolVersion === 1 &&
    typeof placement.state === "string" && STATES.includes(placement.state) &&
    validId(placement.operationId) && validId(placement.projectId) && validId(placement.incarnation) &&
    validId(placement.shardId) && validId(placement.nodeId) &&
    positiveInteger(placement.allocationGeneration) && positiveInteger(placement.mapVersion) &&
    !!resources && typeof resources === "object" && !Array.isArray(resources) &&
    validShardShape(placement.role, placement.shardId, placement.of, placement.virtualRanges, resources) &&
    (placement.durability === "crash" || placement.durability === "power") &&
    positiveInteger(placement.revision) && typeof placement.requestFingerprint === "string" &&
    nonnegativeInteger(placement.epoch) && nonnegativeInteger(placement.projectEpoch) &&
    (placement.state !== "reserved" || placement.projectEpoch === 0);
}

interface PlacementLedger {
  readonly protocolVersion: 1;
  readonly incarnation: string;
  readonly revision: number;
  readonly placements: readonly AppShardPlacement[];
  readonly usedOperationIds: readonly string[];
}

function decodeLedger(value: ZelavisSystemStoreValue, projectId: string): PlacementLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid App shard placement ledger");
  }
  const ledger = value as unknown as PlacementLedger;
  if (ledger.protocolVersion !== 1 || !positiveInteger(ledger.revision) || !validId(ledger.incarnation) ||
      !Array.isArray(ledger.placements) || ledger.placements.length > MAX_PLACEMENTS ||
      !Array.isArray(ledger.usedOperationIds) || ledger.usedOperationIds.length > MAX_OPERATION_IDS ||
      ledger.usedOperationIds.some((id) => !validId(id)) ||
      new Set(ledger.usedOperationIds).size !== ledger.usedOperationIds.length ||
      ledger.placements.some((placement) => !validPlacement(placement)) ||
      ledger.placements.some((placement) => placement.projectId !== projectId || placement.incarnation !== ledger.incarnation) ||
      ledger.placements.some((placement) => !ledger.usedOperationIds.includes(placement.operationId)) ||
      new Set(ledger.placements.map((entry) => entry.shardId)).size !== ledger.placements.length ||
      new Set(ledger.placements.map((entry) => entry.operationId)).size !== ledger.placements.length) {
    throw new Error("Invalid App shard placement ledger");
  }
  return ledger;
}

function fingerprint(request: AppShardPlacementRequest): string {
  return JSON.stringify({
    protocolVersion: request.protocolVersion,
    intent: request.intent,
    operationId: request.operationId,
    projectId: request.projectId,
    shardId: request.shardId,
    of: request.of,
    virtualRanges: [...request.virtualRanges].sort((a, b) => a - b),
    mapVersion: request.mapVersion,
    expectedRevision: request.expectedRevision,
    resources: request.resources,
    durability: request.durability,
  });
}

const isLive = (placement: AppShardPlacement) => placement.state !== "released";

/** A change to a ledger: the ledger to write (none when nothing changes) and the answer to give. */
interface LedgerChange {
  readonly write?: PlacementLedger;
  readonly answer: AppShardPlacementDecision;
}

/**
 * Platform-only authority for App shard placement. The ledger is one conditional System Store record per Project, so
 * aggregate budget and virtual-range uniqueness are atomic, and every transition is one conditional write. Dispatch to
 * an Agent, access tokens and publication are separate authority and are not provided here.
 */
export function createAppShardPlacementAuthority(options: {
  readonly store: ZelavisSystemStore;
  readonly allocation: (projectId: string) => Promise<AppShardAllocation | undefined> | AppShardAllocation | undefined;
  readonly nodes: () => Promise<readonly AppShardPlacementNode[]> | readonly AppShardPlacementNode[];
  /** Incarnation source for a new ledger; `crypto.randomUUID()` unless given. */
  readonly randomId?: () => string;
}): AppShardPlacementAuthority {
  // One CAS record per Project keeps aggregate reservation accounting atomic.
  const keyFor = (projectId: string) => projectId;
  const refuse = (reason: AppShardPlacementRefusal, currentRevision = 0, current?: AppShardPlacement): AppShardPlacementDecision =>
    current ? { granted: false, reason, currentRevision, current } : { granted: false, reason, currentRevision };

  const read = (projectId: string) => present(Effect.gen(function* () {
    const record = (yield* integrationValue(options.store.get(NAMESPACE, keyFor(projectId))));
    return { stored: record, ledger: record ? decodeLedger(record.value, projectId) : undefined };
  }));

  const current = (projectId: string, shardId: string) => present(Effect.gen(function* () {
    if (!validId(projectId) || !validId(shardId)) return undefined;
    const { ledger } = (yield* integrationValue(read(projectId)));
    return ledger?.placements.find((entry) => entry.shardId === shardId);
  }));

  const list = (projectId: string) => present(Effect.gen(function* () {
    if (!validId(projectId)) return { incarnation: undefined, revision: 0, placements: [] };
    const { ledger } = (yield* integrationValue(read(projectId)));
    return { incarnation: ledger?.incarnation, revision: ledger?.revision ?? 0, placements: ledger?.placements ?? [] };
  }));

  /** Writes `next` over `stored` (or creates it) conditionally. */
  const write = (projectId: string, stored: Awaited<ReturnType<typeof read>>["stored"], next: PlacementLedger) =>
    present(Effect.gen(function* () {
      const key = keyFor(projectId);
      const value = next as unknown as ZelavisSystemStoreValue;
      return stored
        ? (yield* integrationValue(options.store.compareAndSet(NAMESPACE, key, stored.updatedAt, value, stored.value)))
        : ((yield* integrationValue(options.store.setIfAbsent(NAMESPACE, key, value)))).created;
    }));

  /** Reads the ledger, applies `change` to it and writes the result conditionally; a lost race reads again and reapplies. */
  const mutate = (projectId: string, change: (ledger: PlacementLedger | undefined) => LedgerChange) =>
    present(Effect.gen(function* (): Effect.fn.Return<AppShardPlacementDecision, IntegrationFailure> {
      if (!validId(projectId)) return refuse("invalid-request");
      let latestRevision = 0;
      for (let round = 0; round < MAX_LEDGER_ROUNDS; round += 1) {
        const { stored, ledger } = (yield* integrationValue(read(projectId)));
        latestRevision = ledger?.revision ?? 0;
        const changed = change(ledger);
        if (!changed.write) return changed.answer;
        if ((yield* integrationValue(write(projectId, stored, changed.write)))) return changed.answer;
      }
      return refuse("revision-conflict", latestRevision);
    }));

  /** The ledger with `entry` replacing its shard's, at the next revision. */
  const withEntry = (ledger: PlacementLedger, entry: AppShardPlacement): LedgerChange => {
    const revision = ledger.revision + 1;
    const placement: AppShardPlacement = { ...entry, revision };
    return {
      write: {
        ...ledger,
        revision,
        placements: [...ledger.placements.filter((other) => other.shardId !== entry.shardId), placement]
          .sort((a, b) => byCodePoint(a.shardId, b.shardId)),
      },
      answer: { granted: true, placement },
    };
  };
  const unchanged = (placement: AppShardPlacement): LedgerChange => ({ answer: { granted: true, placement } });

  /** Looks up the shard and hands its entry to `transit`. */
  const transition = (
    input: { readonly projectId: string; readonly shardId: string },
    transit: (ledger: PlacementLedger, entry: AppShardPlacement) => LedgerChange,
  ) => mutate(input.projectId, (ledger) => {
    if (!validId(input.shardId)) return { answer: refuse("invalid-request", ledger?.revision ?? 0) };
    const entry = ledger?.placements.find((candidate) => candidate.shardId === input.shardId);
    if (!ledger || !entry) return { answer: refuse("unknown-shard", ledger?.revision ?? 0) };
    return transit(ledger, entry);
  });

  const wrongState = (ledger: PlacementLedger, entry: AppShardPlacement): LedgerChange =>
    ({ answer: refuse("wrong-state", ledger.revision, entry) });
  const bumpable = (entry: AppShardPlacement) => entry.epoch < Number.MAX_SAFE_INTEGER;

  return {
    current,
    list,
    beginActivation: (input) => transition(input, (ledger, entry) => {
      if (!validId(input.operationId) || !positiveInteger(input.projectEpoch)) return { answer: refuse("invalid-request", ledger.revision) };
      if (entry.operationId !== input.operationId) return { answer: refuse("operation-conflict", ledger.revision, entry) };
      if (entry.state === "preparing" || entry.state === "committed") return unchanged(entry);
      if (entry.state !== "reserved") return wrongState(ledger, entry);
      if (!bumpable(entry)) return { answer: refuse("invalid-request", ledger.revision, entry) };
      return withEntry(ledger, { ...entry, state: "preparing", epoch: entry.epoch + 1, projectEpoch: input.projectEpoch });
    }),
    commitActivation: (input) => transition(input, (ledger, entry) => {
      if (!validId(input.operationId) || !nonnegativeInteger(input.epoch)) return { answer: refuse("invalid-request", ledger.revision) };
      if (entry.operationId !== input.operationId) return { answer: refuse("operation-conflict", ledger.revision, entry) };
      if (entry.state !== "preparing" && entry.state !== "committed") return wrongState(ledger, entry);
      if (entry.epoch !== input.epoch) return { answer: refuse("stale", ledger.revision, entry) };
      return entry.state === "committed" ? unchanged(entry) : withEntry(ledger, { ...entry, state: "committed" });
    }),
    reissue: (input) => transition(input, (ledger, entry) => {
      if (!positiveInteger(input.projectEpoch)) return { answer: refuse("invalid-request", ledger.revision) };
      if (entry.state !== "committed") return wrongState(ledger, entry);
      if (input.projectEpoch < entry.projectEpoch) return { answer: refuse("stale", ledger.revision, entry) };
      if (input.projectEpoch === entry.projectEpoch) return unchanged(entry);
      if (!bumpable(entry)) return { answer: refuse("invalid-request", ledger.revision, entry) };
      return withEntry(ledger, { ...entry, epoch: entry.epoch + 1, projectEpoch: input.projectEpoch });
    }),
    beginRelease: (input) => transition(input, (ledger, entry) => {
      if (!validId(input.operationId)) return { answer: refuse("invalid-request", ledger.revision) };
      if (entry.operationId !== input.operationId) return { answer: refuse("operation-conflict", ledger.revision, entry) };
      if (entry.state === "releasing" || entry.state === "released") return unchanged(entry);
      if (entry.role === "primary" && ledger.placements.some((replica) =>
        replica.role === "replica" && replica.of === entry.shardId && isLive(replica))) {
        return { answer: refuse("replica-live", ledger.revision, entry) };
      }
      return withEntry(ledger, { ...entry, state: entry.state === "reserved" ? "released" : "releasing" });
    }),
    completeRelease: (input) => transition(input, (ledger, entry) => {
      if (!nonnegativeInteger(input.epoch)) return { answer: refuse("invalid-request", ledger.revision) };
      if (entry.state !== "releasing" && entry.state !== "released") return wrongState(ledger, entry);
      if (entry.epoch !== input.epoch) return { answer: refuse("stale", ledger.revision, entry) };
      return entry.state === "released" ? unchanged(entry) : withEntry(ledger, { ...entry, state: "released" });
    }),
    request(callerProjectId, input, caller) {
      return present(Effect.gen(function* (): Effect.fn.Return<AppShardPlacementDecision, IntegrationFailure> {
        let request: unknown;
        try {
          request = structuredClone(input);
        } catch {
          return refuse("invalid-request");
        }
        const callerNodeId = caller.nodeId;
        if (!validId(callerProjectId) || !validId(callerNodeId) || !validRequest(request)) return refuse("invalid-request");
        if (callerProjectId !== request.projectId) return refuse("foreign-project");
        const allocation = (yield* integrationValue(options.allocation(callerProjectId)));
        if (!allocation || allocation.projectId !== callerProjectId ||
            !positiveInteger(allocation.generation)) return refuse("allocation-unavailable");
        const { stored: existing, ledger } = (yield* integrationValue(read(request.projectId)));
        const revision = ledger?.revision ?? 0;
        const previous = ledger?.placements.find((entry) => entry.shardId === request.shardId);
        const requestFingerprint = fingerprint(request);
        if (previous?.operationId === request.operationId) {
          if (previous.requestFingerprint !== requestFingerprint) return refuse("operation-conflict", revision);
          if (previous.allocationGeneration !== allocation.generation) return refuse("allocation-changed", revision);
          return { granted: true, placement: previous };
        }
        if (ledger?.usedOperationIds.includes(request.operationId)) return refuse("operation-conflict", revision);
        if (request.expectedRevision !== revision) return refuse("revision-conflict", revision);
        const replica = request.intent === "replica";
        if (previous && isLive(previous)) return refuse(replica ? "replica-exists" : "shard-in-use", revision, previous);
        if (ledger && (ledger.usedOperationIds.length >= MAX_OPERATION_IDS ||
            (!previous && ledger.placements.length >= MAX_PLACEMENTS))) return refuse("ledger-full", revision);
        const others = ledger?.placements.filter((entry) => entry.shardId !== request.shardId && isLive(entry)) ?? [];
        let excludedNode: string | undefined;
        if (replica) {
          const primary = others.find((entry) => entry.role === "primary" && entry.shardId === request.of);
          if (primary?.state === "releasing") return refuse("wrong-state", revision, primary);
          excludedNode = primary?.nodeId ?? callerNodeId;
        } else {
          // A primary may be allocated after its local copy was first replicated.
          excludedNode = others.find((entry) => entry.role === "replica" && entry.of === request.shardId)?.nodeId;
          const occupiedRanges = new Set(others.flatMap((entry) => entry.virtualRanges));
          if (request.virtualRanges.some((range) => occupiedRanges.has(range))) return refuse("range-conflict", revision);
        }
        if (request.resources.cpuCores + others.reduce((sum, entry) => sum + entry.resources.cpuCores, 0) > allocation.cpuCores ||
            request.resources.memoryBytes + others.reduce((sum, entry) => sum + entry.resources.memoryBytes, 0) > allocation.memoryBytes ||
            request.resources.diskBytes + others.reduce((sum, entry) => sum + entry.resources.diskBytes, 0) > allocation.diskBytes) return refuse("out-of-envelope", revision);
        const eligible = ((yield* integrationValue(options.nodes()))).filter((node) =>
          node.id !== excludedNode && node.ready && allocation.allowedNodeIds.includes(node.id) &&
          node.cpuCores >= request.resources.cpuCores &&
          node.memoryBytes >= request.resources.memoryBytes &&
          node.diskBytes >= request.resources.diskBytes,
        );
        // Consistent hashing with bounded loads over the eligible Nodes: shards spread by capacity, and a Node joining or
        // leaving moves few of them. The ledger the reservation is written into is the load; an existing reservation was
        // returned above and is never moved by a new proposal.
        const nodeId = proposeBoundedLoadNode(`${request.projectId}\u0000${request.shardId}`, eligible.map((candidate) => ({
          id: candidate.id, weight: candidate.cpuCores, load: others.filter((entry) => entry.nodeId === candidate.id).length,
        })));
        const node = eligible.find((candidate) => candidate.id === nodeId);
        if (!node) return refuse("no-eligible-node", revision);
        const incarnation = ledger?.incarnation ?? (options.randomId?.() ?? crypto.randomUUID());
        const placement: AppShardPlacement = {
          protocolVersion: 1,
          state: "reserved",
          operationId: request.operationId,
          projectId: request.projectId,
          incarnation,
          shardId: request.shardId,
          ...(replica ? { role: "replica", of: request.of } : { role: "primary" }),
          nodeId: node.id,
          allocationGeneration: allocation.generation,
          mapVersion: request.mapVersion,
          virtualRanges: [...request.virtualRanges].sort((a, b) => a - b),
          resources: request.resources,
          durability: request.durability,
          revision: revision + 1,
          requestFingerprint,
          // A released shard's high-water carries over: an epoch only rises.
          epoch: previous?.epoch ?? 0,
          projectEpoch: 0,
        };
        const next: PlacementLedger = {
          protocolVersion: 1,
          incarnation,
          revision: revision + 1,
          placements: [...(ledger?.placements.filter((entry) => entry.shardId !== request.shardId) ?? []), placement]
            .sort((a, b) => byCodePoint(a.shardId, b.shardId)),
          usedOperationIds: [...(ledger?.usedOperationIds ?? []), request.operationId],
        };
        if ((yield* integrationValue(write(request.projectId, existing, next)))) return { granted: true, placement };
        const latestRecord = (yield* integrationValue(read(request.projectId)));
        const latest = latestRecord.ledger?.placements.find((entry) => entry.shardId === request.shardId);
        if (latest?.operationId === request.operationId &&
            latest.requestFingerprint === requestFingerprint &&
            latest.allocationGeneration === allocation.generation) {
          return { granted: true, placement: latest };
        }
        return refuse("revision-conflict", latestRecord.ledger?.revision ?? 0);
      }));
    },
  };
}
