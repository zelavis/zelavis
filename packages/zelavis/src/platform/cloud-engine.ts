import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import type { CapacityProvider } from "../core/provider/index.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { isString, objectFields, optional, parseJson, isUnknown } from "../core/json-validation.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { createCloudCapacityController, type CloudCapacityController } from "./cloud-capacity.js";
import { createNodeEnrollmentAuthority, type NodeEnrollmentAuthority } from "./node-enrollment.js";

/**
 * Composes the bundled cloud service into a running Platform's capacity controller.
 *
 * The engine is a separate, self-contained module (`@zelavis/cloud`'s bundle) loaded by path, never
 * imported statically, so the core carries no cloud code and an installation without the bundle
 * simply has no cloud capacity. Everything the engine needs from the Platform is handed over here:
 * the System Store as its conditional state store, a sealing key derived from the master secret,
 * how to recognise an enrolled node, and the first-boot script that carries a freshly minted
 * single-use enrollment token. Nothing here reads or stores the provider token: the controller owns it.
 *
 * What a machine may be (location, image, approved sizes, ceiling) is operator policy in a file the
 * operator writes, not a default guessed here, because the right values are a property of the cloud.
 */

export class CloudEngineError extends Data.TaggedError("CloudEngineError")<{ readonly message: string; readonly cause?: unknown }> {}
const engineFailure = (message: string, cause?: unknown) => new CloudEngineError({ message, ...(cause === undefined ? {} : { cause }) });

export interface CloudCapacityPolicy {
  readonly location: string;
  readonly image: string;
  readonly maxNodes: number;
  readonly allowedLocations?: readonly string[];
  readonly machineClasses: readonly {
    readonly name: string;
    readonly cpuCores: number;
    readonly memoryBytes: number;
    readonly diskBytes: number;
  }[];
}

const MAX_CLASSES = 16;
const MAX_NODES = 100;

/** Reads and validates the operator's capacity policy file. */
export const readCloudPolicy = (file: string): Effect.Effect<CloudCapacityPolicy, CloudEngineError> => Effect.gen(function* () {
  const text = yield* integration(() => readFile(file, "utf8")).pipe(Effect.mapError((cause) => engineFailure(`The cloud policy file ${file} could not be read.`, cause)));
  const parsed = yield* evaluate(() => parseJson(text, objectFields<{ location?: unknown; image?: unknown; maxNodes?: unknown; allowedLocations?: unknown; machineClasses?: unknown }>({
    location: optional(isUnknown), image: optional(isUnknown), maxNodes: optional(isUnknown), allowedLocations: optional(isUnknown), machineClasses: optional(isUnknown),
  }))).pipe(Effect.mapError((cause) => engineFailure("The cloud policy file is not valid JSON.", cause)));
  const classes = Array.isArray(parsed.machineClasses) ? parsed.machineClasses : [];
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (typeof parsed.location !== "string" || typeof parsed.image !== "string" || !parsed.location || !parsed.image ||
      typeof parsed.maxNodes !== "number" || !Number.isInteger(parsed.maxNodes) || parsed.maxNodes < 1 || parsed.maxNodes > MAX_NODES ||
      classes.length < 1 || classes.length > MAX_CLASSES ||
      classes.some((c) => typeof c !== "object" || c === null || typeof (c as { name?: unknown }).name !== "string" ||
        !number((c as { cpuCores?: unknown }).cpuCores) || !number((c as { memoryBytes?: unknown }).memoryBytes) || !number((c as { diskBytes?: unknown }).diskBytes)) ||
      (parsed.allowedLocations !== undefined && !(Array.isArray(parsed.allowedLocations) && parsed.allowedLocations.every(isString)))) {
    return yield* engineFailure(`The cloud policy needs location, image, maxNodes (1 to ${MAX_NODES}) and 1 to ${MAX_CLASSES} machineClasses with name, cpuCores, memoryBytes and diskBytes.`);
  }
  return {
    location: parsed.location, image: parsed.image, maxNodes: parsed.maxNodes,
    ...(parsed.allowedLocations === undefined ? {} : { allowedLocations: parsed.allowedLocations as string[] }),
    machineClasses: classes as CloudCapacityPolicy["machineClasses"],
  };
});

/** The surface this module needs from the bundle; anything else the bundle exports is ignored. */
interface CloudBundle {
  readonly createHetznerCapacityProvider: (options: Record<string, unknown>) => CapacityProvider;
  readonly workerFirstBootScript: (input: { platformUrl: string; platformFingerprint: string; nodeId: string; enrollmentToken: string; installerUrl?: string }) => string;
}

const loadBundle = (path: string) => integration(() => import(pathToFileURL(path).href) as Promise<Partial<CloudBundle>>).pipe(
  Effect.flatMap((module) => typeof module.createHetznerCapacityProvider === "function" && typeof module.workerFirstBootScript === "function"
    ? Effect.succeed(module as CloudBundle)
    : Effect.fail(engineFailure("The cloud bundle does not export the expected functions."))),
  Effect.mapError((error) => error instanceof CloudEngineError ? error : engineFailure("The cloud bundle could not be loaded.", error)),
);

export const composeCloudCapacity = (options: {
  readonly store: ZelavisSystemStore;
  readonly masterSecret: string;
  readonly platformId: string;
  readonly bundlePath: string;
  readonly policy: CloudCapacityPolicy;
  /** Where machines enroll and the certificate to pin; first-boot data cannot be built without it. */
  readonly endpoint: { readonly url: string; readonly fingerprint: string };
  /** Alchemy's working directory. */
  readonly workDir: string;
  readonly authority?: NodeEnrollmentAuthority;
  readonly now?: () => number;
  /** Overrides the cloud's API root; for tests against a fake only. */
  readonly apiEndpoint?: string;
}): Effect.Effect<CloudCapacityController, CloudEngineError> => Effect.gen(function* () {
  const bundle = yield* loadBundle(options.bundlePath);
  const authority = options.authority ?? createNodeEnrollmentAuthority({ store: options.store, ...(options.now ? { now: options.now } : {}) });
  const secretKey = createHash("sha256").update(`${options.masterSecret}\u0000cloud-provisioning-state`).digest();
  const platformUrl = `${options.endpoint.url.replace(/\/+$/, "")}/zelavis`;

  const firstBootFor = (nodeId: string) => Effect.runPromise(authority.mint({ nodeId, origin: "cloud", replace: true }).pipe(
    Effect.map((minted) => bundle.workerFirstBootScript({
      platformUrl, platformFingerprint: options.endpoint.fingerprint, nodeId, enrollmentToken: minted.token,
    })),
  ));

  return createCloudCapacityController({
    store: options.store, masterSecret: options.masterSecret, platformId: options.platformId,
    ...(options.now ? { now: options.now } : {}),
    firstBootFor,
    buildProvider: (config, firstBoot) => {
      if (config.provider !== "hetzner") throw new Error(`No engine for provider ${config.provider}.`);
      return bundle.createHetznerCapacityProvider({
        token: config.token, platformId: options.platformId, workerId: `platform-${options.platformId}`,
        workDir: options.workDir, store: options.store, secretKey,
        defaults: options.policy,
        ...(options.apiEndpoint === undefined ? {} : { endpoint: options.apiEndpoint }),
        enrollment: { isEnrolled: (nodeId: string) => Effect.runPromise(authority.destination(nodeId)).then((destination) => destination !== undefined) },
        userData: ({ nodeId }: { nodeId: string }) => firstBoot(nodeId),
      });
    },
  });
});
