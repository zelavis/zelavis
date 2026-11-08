import { Effect } from "effect";
import { describeFailure, IntegrationFailure, integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectDispatcher } from "../project.js";
import type {
  AppShardPlacement, AppShardPlacementAuthority, AppShardPlacementDecision, AppShardPlacementRefusal,
} from "./app-data-placement.js";

/** What the Project's writer process needs to reach its shard's storage on the Agent. */
export interface AppShardAccessGrant {
  readonly token: string;
  readonly expiresAt: number;
  readonly destination: { readonly url: string; readonly caPem: string; readonly agentId: string };
  readonly epoch: number;
  readonly nodeId: string;
  readonly incarnation: string;
}

export type AppShardActivationRefusal =
  | AppShardPlacementRefusal | "lease-guarded" | "not-committed" | "agent-unavailable" | "dispatch-unavailable";

export type AppShardActivationResult =
  | { readonly granted: true; readonly placement: AppShardPlacement; readonly access: AppShardAccessGrant }
  | { readonly granted: false; readonly reason: AppShardActivationRefusal; readonly currentRevision: number };

export type AppShardReleaseResult =
  | AppShardPlacementDecision
  | { readonly granted: false; readonly reason: "agent-unavailable" | "dispatch-unavailable"; readonly currentRevision: number };

export interface AppShardActivation {
  /** Drives a reserved shard to `committed` at the caller's Project epoch and answers an access token for it. */
  activate(input: {
    readonly projectId: string; readonly shardId: string; readonly operationId: string; readonly projectEpoch: number;
  }): Promise<AppShardActivationResult>;
  /** A fresh access token for a committed shard; a Project epoch above the entry's reissues the grant first. */
  access(input: { readonly projectId: string; readonly shardId: string; readonly projectEpoch: number }): Promise<AppShardActivationResult>;
  /** Ends the shard: the Agent removes its storage. */
  release(input: { readonly projectId: string; readonly shardId: string; readonly operationId: string }): Promise<AppShardReleaseResult>;
  /** Releases every live shard of a Project, one at a time; rejects while any cannot be released. */
  revokeAll(projectId: string): Promise<void>;
}

type Failure = { readonly granted: false; readonly reason: AppShardActivationRefusal; readonly currentRevision: number };

/**
 * Activation of App shards over the ledger. Every Agent delivery comes after the ledger transition it reflects, and a
 * failed delivery changes nothing further, so a retry carries on from the recorded state.
 */
export function createAppShardActivation(options: {
  readonly authority: AppShardPlacementAuthority;
  readonly dispatcher: () => ZelavisProjectDispatcher | undefined;
  readonly leaseGuarded: boolean;
}): AppShardActivation {
  const { authority } = options;
  const unavailable = (reason: "agent-unavailable" | "dispatch-unavailable", currentRevision: number): Failure =>
    ({ granted: false, reason, currentRevision });

  const revisionOf = (projectId: string) =>
    Effect.map(integration(() => authority.list(projectId)), (view) => view.revision);

  /** Delivers one grant; a failure is logged with its cause and answered as `undefined`. */
  const deliver = (dispatcher: ZelavisProjectDispatcher, placement: AppShardPlacement, state: "preparing" | "committed" | "released") =>
    Effect.gen(function* () {
      if (!dispatcher.deliverAppShardGrant) return false;
      const failure = yield* integration(() => dispatcher.deliverAppShardGrant!({
        nodeId: placement.nodeId, projectId: placement.projectId, incarnation: placement.incarnation,
        shardId: placement.shardId, epoch: placement.epoch, state, durability: placement.durability,
      })).pipe(Effect.as(undefined), Effect.catch((error) => Effect.succeed(error)));
      if (failure === undefined) return true;
      yield* Effect.logWarning(`App shard ${placement.projectId}/${placement.shardId} (${state}, epoch ${placement.epoch}) could not be delivered to ${placement.nodeId}: ${describeFailure(failure)}`);
      return false;
    });

  const toFailure = (decision: AppShardPlacementDecision & { readonly granted: false }): Failure =>
    ({ granted: false, reason: decision.reason, currentRevision: decision.currentRevision });

  /** A committed shard, delivered at its epoch, with a token for it. */
  const grantAccess = (dispatcher: ZelavisProjectDispatcher, placement: AppShardPlacement): Effect.Effect<AppShardActivationResult, IntegrationFailure> =>
    Effect.gen(function* () {
      if (!(yield* deliver(dispatcher, placement, "committed"))) return unavailable("agent-unavailable", placement.revision);
      if (!dispatcher.authorizeAppShardAccess) return unavailable("dispatch-unavailable", placement.revision);
      const signed = yield* integration(() => dispatcher.authorizeAppShardAccess!({
        nodeId: placement.nodeId, projectId: placement.projectId, incarnation: placement.incarnation,
        shardId: placement.shardId, epoch: placement.epoch,
      }));
      return {
        granted: true as const, placement,
        access: {
          token: signed.token, expiresAt: signed.expiresAt, destination: signed.destination,
          epoch: placement.epoch, nodeId: placement.nodeId, incarnation: placement.incarnation,
        },
      };
    });

  const dispatcherOrUndefined = () => {
    const dispatcher = options.dispatcher();
    return dispatcher?.deliverAppShardGrant && dispatcher.authorizeAppShardAccess ? dispatcher : undefined;
  };

  const activate: AppShardActivation["activate"] = (input) => present(Effect.gen(function* () {
    if (options.leaseGuarded) return { granted: false as const, reason: "lease-guarded" as const, currentRevision: yield* revisionOf(input.projectId) };
    const dispatcher = dispatcherOrUndefined();
    if (!dispatcher) return unavailable("dispatch-unavailable", yield* revisionOf(input.projectId));
    const begun = yield* integration(() => authority.beginActivation(input));
    if (!begun.granted) return toFailure(begun);
    let placement = begun.placement;
    if (placement.state === "preparing") {
      if (!(yield* deliver(dispatcher, placement, "preparing"))) return unavailable("agent-unavailable", placement.revision);
      const committed = yield* integration(() => authority.commitActivation({
        projectId: input.projectId, shardId: input.shardId, operationId: input.operationId, epoch: placement.epoch,
      }));
      if (!committed.granted) return toFailure(committed);
      placement = committed.placement;
    }
    if (placement.state !== "committed") return { granted: false as const, reason: "wrong-state" as const, currentRevision: placement.revision };
    if (placement.projectEpoch !== input.projectEpoch) {
      const reissued = yield* integration(() => authority.reissue({
        projectId: input.projectId, shardId: input.shardId, projectEpoch: input.projectEpoch,
      }));
      if (!reissued.granted) return toFailure(reissued);
      placement = reissued.placement;
    }
    return yield* grantAccess(dispatcher, placement);
  }));

  const access: AppShardActivation["access"] = (input) => present(Effect.gen(function* () {
    if (options.leaseGuarded) return { granted: false as const, reason: "lease-guarded" as const, currentRevision: yield* revisionOf(input.projectId) };
    const dispatcher = dispatcherOrUndefined();
    if (!dispatcher) return unavailable("dispatch-unavailable", yield* revisionOf(input.projectId));
    const entry = yield* integration(() => authority.current(input.projectId, input.shardId));
    if (!entry) return { granted: false as const, reason: "unknown-shard" as const, currentRevision: yield* revisionOf(input.projectId) };
    if (entry.state !== "committed") return { granted: false as const, reason: "not-committed" as const, currentRevision: entry.revision };
    const reissued = yield* integration(() => authority.reissue({
      projectId: input.projectId, shardId: input.shardId, projectEpoch: input.projectEpoch,
    }));
    if (!reissued.granted) return toFailure(reissued);
    return yield* grantAccess(dispatcher, reissued.placement);
  }));

  /** `releasing` → Agent removes storage → `released`; a reservation never delivered ends `released` at once. */
  const finishRelease = (dispatcher: ZelavisProjectDispatcher | undefined, begun: AppShardPlacement) => Effect.gen(function* () {
    if (begun.state === "released") return { granted: true as const, placement: begun } as AppShardReleaseResult;
    if (!dispatcher) return unavailable("dispatch-unavailable", begun.revision) as AppShardReleaseResult;
    if (!(yield* deliver(dispatcher, begun, "released"))) return unavailable("agent-unavailable", begun.revision) as AppShardReleaseResult;
    return yield* integration(() => authority.completeRelease({
      projectId: begun.projectId, shardId: begun.shardId, epoch: begun.epoch,
    }));
  });

  const release: AppShardActivation["release"] = (input) => present(Effect.gen(function* () {
    const begun = yield* integration(() => authority.beginRelease(input));
    if (!begun.granted) return begun as AppShardReleaseResult;
    return yield* finishRelease(options.dispatcher(), begun.placement);
  }));

  const revokeAll: AppShardActivation["revokeAll"] = (projectId) => present(Effect.gen(function* () {
    const view = yield* integration(() => authority.list(projectId));
    const live = view.placements.filter((entry) => entry.state !== "released")
      .sort((left, right) => Number(right.role === "replica") - Number(left.role === "replica"));
    yield* Effect.forEach(live, (entry) => Effect.gen(function* () {
      const begun = yield* integration(() => authority.beginRelease({ projectId, shardId: entry.shardId, operationId: entry.operationId }));
      const finished: AppShardReleaseResult = begun.granted ? yield* finishRelease(options.dispatcher(), begun.placement) : begun;
      if (!finished.granted) {
        return yield* new IntegrationFailure(new Error(`Shard ${entry.shardId} of ${projectId} could not be released on node ${entry.nodeId}: ${finished.reason}`));
      }
    }), { concurrency: 1, discard: true });
  }));

  return { activate, access, release, revokeAll };
}
