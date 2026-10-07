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
