import { Effect } from "effect";
import { arrayOf, isFiniteNumber, isRecord, isString, literal, objectFields, optional } from "../core/json-validation.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { ShardPlacementRefused, ShardPlacementUnavailable, StoreError } from "./errors.js";
import type { ShardPlacementHost, ShardPlacementView, ShardResources } from "./shard-placement.js";

/**
 * The Project's channel to the Platform for its own remote shards (`/runtime/project-shards/:projectId/...`),
 * authorized by the capability the Platform started the Project with.
 *
 * Every call is bounded. Failures to reach the Platform, and anything that is not a plain answer, are
 * `ShardPlacementUnavailable`, which the shard operation retries; a 400 or 409 carries the Platform's refusal
 * code and is `ShardPlacementRefused`, which ends it.
 */
export interface ShardChannelOptions {
  /** The Platform's API root, e.g. `https://platform.example/zelavis/api/v1`. */
  readonly apiRoot: string;
  readonly token: string;
  readonly projectId: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds a call may take; 10_000 unless given. */
  readonly timeoutMillis?: number;
}

export interface ShardAccessAnswer {
  readonly token: string;
  readonly expiresAt: number;
  readonly destination: { readonly url: string; readonly caPem: string };
}

export interface ShardChannel {
  readonly list: ShardPlacementHost["list"];
  readonly request: (input: Parameters<ShardPlacementHost["request"]>[0] & { readonly durability: "crash" | "power" }) =>
    ReturnType<ShardPlacementHost["request"]>;
  readonly activate: ShardPlacementHost["activate"];
  readonly release: ShardPlacementHost["release"];
  readonly access: (shardId: string) => Effect.Effect<ShardAccessAnswer, StoreError>;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const isDestination = objectFields<{ url: string; caPem: string }>({ url: isString, caPem: isString });
const isAccess = objectFields<ShardAccessAnswer>({ token: isString, expiresAt: isFiniteNumber, destination: isDestination });
const isEntry = objectFields<ShardPlacementView["placements"][number]>({
  shardId: isString, operationId: isString, state: isString, nodeId: isString, epoch: isFiniteNumber,
  virtualRanges: arrayOf(isFiniteNumber), role: literal("primary", "replica"), of: optional(isString),
});

export const httpShardChannel = (options: ShardChannelOptions): ShardChannel => {
  const send = options.fetch ?? fetch;
  const timeout = options.timeoutMillis ?? 10_000;
  const root = `${options.apiRoot.replace(/\/+$/, "")}/runtime/project-shards/${encodeURIComponent(options.projectId)}`;

  const call = (suffix: string, init: { readonly method: string; readonly body?: unknown }): Effect.Effect<Answer, ShardPlacementUnavailable> =>
    Effect.gen(function* () {
      const response = yield* integration((signal) => send(`${root}${suffix}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      }), { interruptible: true });
      const text = yield* integration(() => response.text(), { interruptible: true });
      // An answer that is not JSON is read as an empty body: its status alone decides what it means.
      const parsed = yield* Effect.match(Effect.try(() => JSON.parse(text) as unknown), {
        onFailure: () => undefined, onSuccess: (value) => value,
      });
      return { status: response.status, body: isRecord(parsed) ? parsed : {} };
    }).pipe(Effect.mapError((failure) =>
      new ShardPlacementUnavailable({ reason: `the Platform could not be reached: ${String((failure as { cause?: unknown }).cause ?? failure)}` })));

  /** 400 and 409 are the Platform's refusals; anything else that is not 200 is "unavailable". */
  const refusalOf = (answer: Answer): ShardPlacementRefused | ShardPlacementUnavailable => {
    const code = answer.body.code;
    if ((answer.status === 400 || answer.status === 409) && isString(code)) return new ShardPlacementRefused({ reason: code });
    return new ShardPlacementUnavailable({ reason: `the Platform answered ${answer.status}` });
  };
  const malformed = (what: string) => new ShardPlacementUnavailable({ reason: `the Platform answered a malformed ${what}` });

  const placementOf = (answer: Answer) => {
    const placement = answer.body.placement;
    return isEntry(placement) ? placement : undefined;
  };

  return {
    list: Effect.gen(function* () {
      const answer = yield* call("", { method: "GET" });
      if (answer.status !== 200) return yield* new ShardPlacementUnavailable({ reason: `the Platform answered ${answer.status}` });
      const { revision, placements, callerNodeId } = answer.body;
      if (!isFiniteNumber(revision) || !isString(callerNodeId) || !arrayOf(isEntry)(placements)) return yield* malformed("ledger");
      return {
        revision, callerNodeId,
        placements: placements.map((entry) => ({
          shardId: entry.shardId, operationId: entry.operationId, state: entry.state, nodeId: entry.nodeId,
          epoch: entry.epoch, virtualRanges: entry.virtualRanges,
          role: entry.role, ...(entry.of === undefined ? {} : { of: entry.of }),
        })),
      } satisfies ShardPlacementView;
    }),

    request: (input) =>
      Effect.gen(function* () {
        const { resources, ...rest } = input;
        const answer = yield* call("/requests", {
          method: "POST",
          body: { protocolVersion: 1, projectId: options.projectId, ...rest, resources: resources satisfies ShardResources },
        });
        if (answer.status !== 200) return yield* refusalOf(answer);
        const placement = placementOf(answer);
        return placement === undefined ? yield* malformed("placement") : { nodeId: placement.nodeId };
      }),

    activate: (input) =>
      Effect.gen(function* () {
        const answer = yield* call(`/${encodeURIComponent(input.shardId)}/activate`, {
          method: "POST", body: { operationId: input.operationId },
        });
        if (answer.status !== 200) return yield* refusalOf(answer);
        const placement = placementOf(answer);
        return placement === undefined ? yield* malformed("placement") : { epoch: placement.epoch, nodeId: placement.nodeId };
      }),

    release: (input) =>
      Effect.gen(function* () {
        const answer = yield* call(`/${encodeURIComponent(input.shardId)}/release`, {
          method: "POST", body: { operationId: input.operationId },
        });
        if (answer.status !== 200) return yield* refusalOf(answer);
      }),

    access: (shardId) =>
      Effect.gen(function* () {
        const answer = yield* call(`/${encodeURIComponent(shardId)}/access`, { method: "POST" });
        if (answer.status !== 200) {
          return yield* new StoreError({ op: "shard.access", cause: `the Platform refused access to shard ${shardId}: ${answer.status} ${String(answer.body.code ?? "")}`.trim() });
        }
        if (!isAccess(answer.body.access)) return yield* new StoreError({ op: "shard.access", cause: "the Platform answered a malformed access token" });
        return answer.body.access;
      }).pipe(Effect.mapError((failure) =>
        failure instanceof StoreError ? failure : new StoreError({ op: "shard.access", cause: failure.reason }))),
  };
};
