import { Data, Effect, Semaphore } from "effect";
import { workerFirstBootScript } from "../core/provider/index.js";
import { createWebhookCapacityProvider } from "./cloud-webhook-provider.js";
import type { CapacityProvider } from "../core/provider/index.js";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { createCloudCapacityController, type CloudCapacityController } from "./cloud-capacity.js";
import { createNodeEnrollmentAuthority, type NodeEnrollmentAuthority } from "./node-enrollment.js";

/** Composes cloud capacity; the provider bundle is acquired only on first use. */
export class CloudEngineError extends Data.TaggedError("CloudEngineError")<{ readonly message: string; readonly cause?: unknown }> {}
const engineFailure = (message: string, cause?: unknown) => new CloudEngineError({ message, ...(cause === undefined ? {} : { cause }) });

/** The surface this module needs from the bundle; anything else the bundle exports is ignored. */
interface CloudBundle {
  readonly createHetznerCapacityProvider: (options: Record<string, unknown>) => CapacityProvider;
}

const loadBundle = (path: string) => integration(() => import(path) as Promise<Partial<CloudBundle>>).pipe(
  Effect.flatMap((module) => typeof module.createHetznerCapacityProvider === "function"
    ? Effect.succeed(module as CloudBundle)
    : Effect.fail(engineFailure("The cloud bundle does not export the expected functions."))),
  Effect.mapError((error) => error instanceof CloudEngineError ? error : engineFailure("The cloud bundle could not be loaded.", error)),
);

const AUTHORITY_NAMESPACE = "fabric.cloud-authority.v1";
const AUTHORITY_ATTEMPTS = 8;

/**
 * Claims cloud authority for this Platform process: a strictly increasing epoch in the System Store. A later process on
 * the same store (a promoted standby, a restored copy) claims a higher one, and this process's `isCurrent` is false from
 * then on, so a deposed Platform can no longer create or delete machines.
 */
export const claimCloudAuthority = (store: ZelavisSystemStore, platformId: string): Effect.Effect<{ readonly epoch: number; readonly isCurrent: () => Promise<boolean> }, CloudEngineError> => Effect.gen(function* () {
  const epochOf = (value: unknown) => typeof value === "object" && value !== null && Number.isSafeInteger((value as { epoch?: unknown }).epoch) ? (value as { epoch: number }).epoch : 0;
  for (let attempt = 0; attempt < AUTHORITY_ATTEMPTS; attempt++) {
    const current = yield* integration(() => store.get(AUTHORITY_NAMESPACE, platformId)).pipe(Effect.mapError((cause) => engineFailure("Cloud authority could not be read.", cause)));
    const previous = current === undefined ? 0 : epochOf(current.value);
    if (current !== undefined && previous < 1) return yield* engineFailure("The stored cloud authority is malformed.");
    if (previous >= Number.MAX_SAFE_INTEGER) return yield* engineFailure("Cloud authority is exhausted.");
    const epoch = previous + 1;
    const claimed = current === undefined
      ? yield* integration(() => store.setIfAbsent(AUTHORITY_NAMESPACE, platformId, { epoch })).pipe(Effect.map((result) => result.created), Effect.mapError((cause) => engineFailure("Cloud authority could not be claimed.", cause)))
      : yield* integration(() => store.compareAndSet(AUTHORITY_NAMESPACE, platformId, current.updatedAt, { epoch }, current.value)).pipe(Effect.map((result) => result !== undefined), Effect.mapError((cause) => engineFailure("Cloud authority could not be claimed.", cause)));
    if (claimed) return { epoch, isCurrent: () => Effect.runPromise(integration(() => store.get(AUTHORITY_NAMESPACE, platformId)).pipe(Effect.map((record) => epochOf(record?.value) === epoch))) };
  }
  return yield* engineFailure("Cloud authority is contended; another Platform process keeps claiming it.");
});

export const composeCloudCapacity = (options: {
  readonly store: ZelavisSystemStore;
  readonly masterSecret: string;
  readonly platformId: string;
  readonly bundlePath: string;
  /** Where machines enroll and the certificate to pin; first-boot data cannot be built without it. */
  readonly endpoint: { readonly url: string; readonly fingerprint: string };
  /** Alchemy's working directory. */
  readonly workDir: string;
  readonly authority?: NodeEnrollmentAuthority;
  readonly now?: () => number;
  /** Overrides the cloud's API root; for tests against a fake only. */
  readonly apiEndpoint?: string;
}): Effect.Effect<CloudCapacityController, CloudEngineError> => Effect.gen(function* () {
  const bundle = yield* Effect.cached(loadBundle(options.bundlePath));
  const cloudAuthority = yield* claimCloudAuthority(options.store, options.platformId);
  const authority = options.authority ?? createNodeEnrollmentAuthority({ store: options.store, ...(options.now ? { now: options.now } : {}) });
  const secretKey = new Uint8Array(yield* integration(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${options.masterSecret}\u0000cloud-provisioning-state`))).pipe(Effect.mapError(cause => engineFailure("The cloud state key could not be derived.", cause))));
  const platformUrl = `${options.endpoint.url.replace(/\/+$/, "")}/zelavis`;

  const calls = Semaphore.makeUnsafe(2);
  const mutations = Semaphore.makeUnsafe(1);
  const isEnrolled = (nodeId: string) => Effect.runPromise(authority.destination(nodeId).pipe(Effect.map(destination => destination !== undefined)));
  const firstBootFor = (nodeId: string) => Effect.runPromise(Effect.gen(function* () {
    const minted = yield* authority.mint({ nodeId, origin: "cloud", replace: true });
    return workerFirstBootScript({
      platformUrl, platformFingerprint: options.endpoint.fingerprint, nodeId, enrollmentToken: minted.token,
    });
  }));

  return createCloudCapacityController({
    store: options.store, masterSecret: options.masterSecret, platformId: options.platformId,
    ...(options.now ? { now: options.now } : {}),
    firstBootFor,
    buildProvider: (config, firstBoot, policy) => Effect.runPromise(Effect.gen(function* () {
      if (config.provider === "webhook") return createWebhookCapacityProvider({ endpoint: config.endpoint!, secret: config.token, platformId: options.platformId, store: options.store, policy, firstBoot, isEnrolled, authority: cloudAuthority.isCurrent, calls, mutations });
      const loaded = yield* bundle;
      if (config.provider !== "hetzner") throw new Error(`No engine for provider ${config.provider}.`);
      return loaded.createHetznerCapacityProvider({
        token: config.token, platformId: options.platformId, workerId: `platform-${options.platformId}`,
        workDir: options.workDir, store: options.store, secretKey, authority: cloudAuthority.isCurrent,
        defaults: policy,
        ...(options.apiEndpoint === undefined ? {} : { endpoint: options.apiEndpoint }),
        enrollment: { isEnrolled },
        userData: ({ nodeId }: { nodeId: string }) => firstBoot(nodeId),
      });
    })),
  });
});
