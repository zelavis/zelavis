import { Data, Effect } from "effect";
import type { CapacityProvider, ZelavisCapacityNode, ZelavisCapacityProvisionInput } from "../core/provider/index.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "../edge/acme-crypto.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

/**
 * Cloud capacity for the Platform: one provider connection and the requests made through it.
 *
 * Authority. Fabric alone decides allocation, placement, draining and fencing. This
 * controller only asks a provisioning engine for machines and releases them; a machine is
 * not a Node until enrollment verifies it (`ready` comes from the provider contract, which
 * reports ready only after enrollment). The engine (`@zelavis/cloud`) is injected, never
 * imported, so the core runtime carries no cloud code.
 *
 * The provider token is the one durable secret here. It is sealed (AES-256-GCM, key derived
 * from the Platform master secret and bound to this record's purpose), never returned, never
 * logged and never placed in first-boot data. Every use is audited with the acting principal;
 * a use that cannot be audited does not happen.
 *
 * Bounds. At most one connection; every string is length- and charset-checked; the audit
 * trail is bounded by retention pruning; nothing is retried here.
 */

export const CLOUD_CONNECTION_NAMESPACE = "fabric.cloud-connection.v1";
export const CLOUD_AUDIT_NAMESPACE = "fabric.cloud-audit.v1";
export const CLOUD_SCALING_NAMESPACE = "fabric.cloud-scaling.v1";
const SCALING_KEY = "default";
const LAST_REQUEST_KEY = "last-request";
/** A shortfall must hold this long before a machine is requested: sustained need, not a spike. */
export const SCALE_OUT_SUSTAIN_MS = 2 * 60_000;
export const MAX_SCALING_MACHINES = 20;
export const MAX_SCALING_COOLDOWN_MINUTES = 24 * 60;
const CONNECTION_KEY = "default";
const SEAL_PURPOSE = "cloud-provider-token";
const MAX_TOKEN_LENGTH = 512;
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const AUDIT_PRUNE_PAGE = 50;

/** Providers the Platform can connect. Adding one is a deliberate change, not a runtime string. */
export const CLOUD_PROVIDERS = ["hetzner"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

export type CloudCapacityCode =
  | "invalid-request" | "not-connected" | "already-connected" | "has-nodes" | "audit-unavailable" | "provider-failed";

export class CloudCapacityError extends Data.TaggedError("CloudCapacityError")<{
  readonly code: CloudCapacityCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const fail = (code: CloudCapacityCode, message: string, cause?: unknown) =>
  Effect.fail(new CloudCapacityError({ code, message, ...(cause === undefined ? {} : { cause }) }));

/** What an operator may see of the connection: never the token or its ciphertext. */
export interface CloudConnectionSummary {
  readonly provider: CloudProviderId;
  readonly label: string;
  readonly connectedAt: number;
  readonly connectedBy: string;
  /** Last four characters, enough to tell two tokens apart. */
  readonly tokenHint: string;
}

interface ConnectionRecord extends CloudConnectionSummary {
  readonly sealed: EncryptedSecret;
}

/**
 * Whether Zelavis may spend money by itself. Separate from the connection on purpose:
 * connecting a provider lets a person request machines, consent lets the Platform do it.
 * Absent means no consent.
 */
export interface CloudScalingSettings {
  readonly consent: boolean;
  /** Most machines this Platform will have created at once, automatic or not. */
  readonly maxMachines: number;
  /** Least time between two automatic requests. */
  readonly cooldownMinutes: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export const DEFAULT_SCALING: CloudScalingSettings = { consent: false, maxMachines: 1, cooldownMinutes: 15, updatedAt: 0, updatedBy: "" };

/** Why the last look at demand did or did not request a machine. */
export type CloudScaleOutOutcome =
  | "idle" | "no-provider" | "no-consent" | "waiting" | "booting" | "at-limit" | "cooling-down" | "requested" | "failed";

export interface CloudScalingStatus {
  readonly settings: CloudScalingSettings;
  readonly last?: { readonly outcome: CloudScaleOutOutcome; readonly at: number };
}

const isScaling = (value: unknown): value is CloudScalingSettings => {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.consent === "boolean" && Number.isInteger(v.maxMachines) && Number.isInteger(v.cooldownMinutes) &&
    Number.isFinite(v.updatedAt) && typeof v.updatedBy === "string";
};

export interface CloudProviderConfig {
  readonly provider: CloudProviderId;
  readonly token: string;
}

export interface CloudCapacityOptions {
  readonly store: ZelavisSystemStore;
  /** The Platform master secret; the sealing key is derived from it and the record's purpose. */
  readonly masterSecret: string;
  readonly platformId: string;
  /** Builds the provisioning engine for a connection. `firstBoot` mints the machine's enrollment. */
  readonly buildProvider: (config: CloudProviderConfig, firstBoot: (nodeId: string) => Promise<string>) => CapacityProvider | Promise<CapacityProvider>;
  /** Mints the single-use enrollment token for a machine and returns its first-boot script. */
  readonly firstBootFor: (nodeId: string) => Promise<string>;
  readonly now?: () => number;
}

const sealKey = (masterSecret: string) => `${masterSecret}\u0000${SEAL_PURPOSE}`;
const asValue = (value: unknown) => value as ZelavisSystemStoreValue;

const isConnection = (value: unknown): value is ConnectionRecord => {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (CLOUD_PROVIDERS as readonly string[]).includes(v.provider as string) && typeof v.label === "string" &&
    Number.isFinite(v.connectedAt) && typeof v.connectedBy === "string" && typeof v.tokenHint === "string" &&
    typeof v.sealed === "object" && v.sealed !== null;
};

const summarize = ({ sealed: _sealed, ...summary }: ConnectionRecord): CloudConnectionSummary => summary;

export function createCloudCapacityController(options: CloudCapacityOptions) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());

  const readRecord = integration(() => store.get(CLOUD_CONNECTION_NAMESPACE, CONNECTION_KEY)).pipe(
    Effect.flatMap((record) => record === undefined || isConnection(record.value)
      ? Effect.succeed(record === undefined ? undefined : (record.value as unknown as ConnectionRecord))
      : fail("provider-failed", "The stored cloud connection is malformed.")),
    Effect.mapError((error) => error instanceof CloudCapacityError ? error
      : new CloudCapacityError({ code: "provider-failed", message: "The cloud connection could not be read.", cause: error })),
  );

  const audit = (principalId: string, action: string, detail: Readonly<Record<string, string>> = {}) =>
    Effect.gen(function* () {
      const at = now();
      const id = `${String(at).padStart(15, "0")}-${crypto.randomUUID()}`;
      yield* integration(() => store.set(CLOUD_AUDIT_NAMESPACE, id, asValue({ at, principalId, action, ...detail }))).pipe(
        Effect.mapError(() => new CloudCapacityError({ code: "audit-unavailable", message: "The action was not run because it could not be recorded." })),
      );
      // Old records are pruned oldest first and best effort: a failed prune never blocks the action.
      yield* integration(() => store.page(CLOUD_AUDIT_NAMESPACE, { limit: AUDIT_PRUNE_PAGE })).pipe(
        Effect.flatMap((page) => Effect.forEach(
          page.records.filter((record) => (record.value as { at?: number }).at !== undefined && at - (record.value as { at: number }).at > AUDIT_RETENTION_MS),
          (record) => integration(() => store.delete(CLOUD_AUDIT_NAMESPACE, record.key)),
          { concurrency: 4, discard: true },
        )),
        Effect.catch(() => Effect.void),
      );
    });

  const providerOf = (config: CloudProviderConfig) =>
    integration(() => options.buildProvider(config, options.firstBootFor)).pipe(
      Effect.mapError((error) => new CloudCapacityError({ code: "provider-failed", message: "The cloud provider could not be prepared.", cause: error })),
    );

  /** The connection and an engine built from its token, which exists only for the call. */
  const connected = Effect.gen(function* () {
    const record = yield* readRecord;
    if (record === undefined) return yield* fail("not-connected", "No cloud provider is connected.");
    const token = yield* Effect.try({
      try: () => decryptSecret(record.sealed, sealKey(options.masterSecret)),
      catch: (cause) => new CloudCapacityError({ code: "provider-failed", message: "The stored provider token could not be opened.", cause }),
    });
    return { record, provider: yield* providerOf({ provider: record.provider, token }) };
  });

  let shortfallSince: number | undefined;
  let lastLook: { outcome: CloudScaleOutOutcome; at: number } | undefined;

  const readScaling = integration(() => store.get(CLOUD_SCALING_NAMESPACE, SCALING_KEY)).pipe(
    Effect.flatMap((record) => record === undefined ? Effect.succeed(DEFAULT_SCALING)
      : isScaling(record.value) ? Effect.succeed(record.value as CloudScalingSettings)
      : fail("provider-failed", "The stored scaling settings are malformed.")),
    Effect.mapError((error) => error instanceof CloudCapacityError ? error
      : new CloudCapacityError({ code: "provider-failed", message: "The scaling settings could not be read.", cause: error })),
  );

  const wrap = <A>(action: () => Promise<A> | A) =>
    integration(() => action()).pipe(
      Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: cause.message, cause })),
    );

  return {
    connection: () => readRecord.pipe(Effect.map((record) => record === undefined ? undefined : summarize(record))),

    connect: (input: { readonly provider: string; readonly token: string; readonly label?: string; readonly principalId: string }) =>
      Effect.gen(function* () {
        if (!(CLOUD_PROVIDERS as readonly string[]).includes(input.provider)) {
          return yield* fail("invalid-request", `The cloud provider must be one of: ${CLOUD_PROVIDERS.join(", ")}.`);
        }
        if (typeof input.token !== "string" || !TOKEN.test(input.token) || input.token.length > MAX_TOKEN_LENGTH) {
          return yield* fail("invalid-request", "The provider token has an unexpected shape.");
        }
        const label = input.label ?? input.provider;
        if (!LABEL.test(label)) return yield* fail("invalid-request", "The label has characters that are not allowed.");
        if ((yield* readRecord) !== undefined) return yield* fail("already-connected", "A cloud provider is already connected; disconnect it first.");
        const provider = input.provider as CloudProviderId;
        // The token is proved by use before it is kept: a token that cannot list is not stored.
        const engine = yield* providerOf({ provider, token: input.token });
        yield* wrap(() => engine.list());
        yield* audit(input.principalId, "connect", { provider });
        const record: ConnectionRecord = {
          provider, label, connectedAt: now(), connectedBy: input.principalId,
          tokenHint: input.token.slice(-4),
          sealed: encryptSecret(input.token, sealKey(options.masterSecret)),
        };
        const created = yield* integration(() => store.setIfAbsent(CLOUD_CONNECTION_NAMESPACE, CONNECTION_KEY, asValue(record))).pipe(
          Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The connection could not be stored.", cause })),
        );
        if (!created.created) return yield* fail("already-connected", "A cloud provider is already connected; disconnect it first.");
        return summarize(record);
      }),

    /** Removes the token. Refused while machines this Platform created still exist, because releasing them needs it. */
    disconnect: (principalId: string) => Effect.gen(function* () {
      const { record, provider } = yield* connected;
      const nodes = yield* wrap(() => provider.list());
      if (nodes.length > 0) return yield* fail("has-nodes", `${nodes.length} machine(s) created by this Platform still exist; release them first.`);
      yield* audit(principalId, "disconnect", { provider: record.provider });
      yield* integration(() => store.delete(CLOUD_CONNECTION_NAMESPACE, CONNECTION_KEY)).pipe(
        Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The connection could not be removed.", cause })),
      );
      // Consent belongs to the connection it was given for: a later connection starts without it.
      yield* Effect.forEach([SCALING_KEY, LAST_REQUEST_KEY], (key) => integration(() => store.delete(CLOUD_SCALING_NAMESPACE, key)), { discard: true }).pipe(
        Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The scaling settings could not be removed.", cause })),
      );
      shortfallSince = undefined;
    }),

    scaling: (): Effect.Effect<CloudScalingStatus, CloudCapacityError> =>
      readScaling.pipe(Effect.map((settings) => ({ settings, ...(lastLook ? { last: lastLook } : {}) }))),

    /** Records whether Zelavis may request machines by itself, and within which limits. */
    setScaling: (input: { readonly consent: boolean; readonly maxMachines: number; readonly cooldownMinutes: number; readonly principalId: string }) =>
      Effect.gen(function* () {
        if (typeof input.consent !== "boolean") return yield* fail("invalid-request", "consent must be true or false.");
        if (!Number.isInteger(input.maxMachines) || input.maxMachines < 1 || input.maxMachines > MAX_SCALING_MACHINES) {
          return yield* fail("invalid-request", `maxMachines must be a whole number from 1 to ${MAX_SCALING_MACHINES}.`);
        }
        if (!Number.isInteger(input.cooldownMinutes) || input.cooldownMinutes < 1 || input.cooldownMinutes > MAX_SCALING_COOLDOWN_MINUTES) {
          return yield* fail("invalid-request", `cooldownMinutes must be a whole number from 1 to ${MAX_SCALING_COOLDOWN_MINUTES}.`);
        }
        if ((yield* readRecord) === undefined) return yield* fail("not-connected", "No cloud provider is connected.");
        yield* audit(input.principalId, input.consent ? "scaling-enable" : "scaling-disable", {
          maxMachines: String(input.maxMachines), cooldownMinutes: String(input.cooldownMinutes),
        });
        const settings: CloudScalingSettings = {
          consent: input.consent, maxMachines: input.maxMachines, cooldownMinutes: input.cooldownMinutes,
          updatedAt: now(), updatedBy: input.principalId,
        };
        yield* integration(() => store.set(CLOUD_SCALING_NAMESPACE, SCALING_KEY, asValue(settings))).pipe(
          Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The scaling settings could not be stored.", cause })),
        );
        if (!input.consent) shortfallSince = undefined;
        return settings;
      }),

    /**
     * Fabric's demand signal: how many replicas could not be placed for lack of capacity.
     * Called on every reconcile, so it is cheap when there is nothing to do. It requests at
     * most one machine, only with consent, only after the shortfall has held for
     * `SCALE_OUT_SUSTAIN_MS`, never while a machine is still booting, never past the limit
     * and never inside the cooldown. It does not fail: the outcome says what happened, and a
     * failure to ask is audited like any other use of the token.
     */
    observeShortfall: (unplaced: number): Effect.Effect<CloudScaleOutOutcome> => Effect.gen(function* () {
      const at = now();
      const decide = Effect.gen(function* () {
        if (unplaced <= 0) { shortfallSince = undefined; return "idle" as const; }
        if ((yield* readRecord) === undefined) return "no-provider" as const;
        const settings = yield* readScaling;
        if (!settings.consent) return "no-consent" as const;
        shortfallSince ??= at;
        if (at - shortfallSince < SCALE_OUT_SUSTAIN_MS) return "waiting" as const;
        const { provider } = yield* connected;
        const machines = yield* wrap(() => provider.list());
        if (machines.some((machine) => machine.state === "provisioning")) return "booting" as const;
        if (machines.length >= settings.maxMachines) return "at-limit" as const;
        const cooldownMs = settings.cooldownMinutes * 60_000;
        const last = yield* integration(() => store.get(CLOUD_SCALING_NAMESPACE, LAST_REQUEST_KEY)).pipe(
          Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The last request could not be read.", cause })),
        );
        const lastAt = typeof last?.value === "number" ? last.value : 0;
        if (at - lastAt < cooldownMs) return "cooling-down" as const;
        // Written before asking: if the ask fails the cooldown still holds, so a refusing cloud is not hammered.
        yield* integration(() => store.set(CLOUD_SCALING_NAMESPACE, LAST_REQUEST_KEY, asValue(at))).pipe(
          Effect.mapError((cause) => new CloudCapacityError({ code: "provider-failed", message: "The request time could not be stored.", cause })),
        );
        yield* audit("autoscaler", "provision", { requestId: `auto-${Math.floor(at / cooldownMs)}`, shortfall: String(unplaced) });
        yield* wrap(() => provider.provision({ requestId: `auto-${Math.floor(at / cooldownMs)}`, platformId: options.platformId }));
        return "requested" as const;
      });
      const outcome = yield* decide.pipe(Effect.catch(() => Effect.succeed("failed" as const)));
      if (outcome !== "idle") lastLook = { outcome, at };
      return outcome;
    }),

    nodes: (): Effect.Effect<readonly ZelavisCapacityNode[], CloudCapacityError> => Effect.gen(function* () {
      const { provider } = yield* connected;
      return yield* wrap(() => provider.list());
    }),

    request: (input: { readonly requestId: string; readonly region?: string; readonly resources?: ZelavisCapacityProvisionInput["resources"]; readonly principalId: string }) =>
      Effect.gen(function* () {
        if (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) {
          return yield* fail("invalid-request", "The request id has characters that are not allowed.");
        }
        const { provider } = yield* connected;
        yield* audit(input.principalId, "provision", { requestId: input.requestId });
        return yield* wrap(() => provider.provision({
          requestId: input.requestId,
          platformId: options.platformId,
          ...(input.region === undefined ? {} : { region: input.region }),
          ...(input.resources === undefined ? {} : { resources: input.resources }),
        }));
      }),

    release: (input: { readonly nodeId: string; readonly principalId: string }) => Effect.gen(function* () {
      if (typeof input.nodeId !== "string" || !NODE_ID.test(input.nodeId)) return yield* fail("invalid-request", "The node id has characters that are not allowed.");
      const { provider } = yield* connected;
      yield* audit(input.principalId, "release", { nodeId: input.nodeId });
      yield* wrap(() => provider.release(input.nodeId));
    }),
  };
}

export type CloudCapacityController = ReturnType<typeof createCloudCapacityController>;
