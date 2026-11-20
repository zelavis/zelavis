/** Read-only views of the published Alpha Identity layouts. The Project writer
 * wrapped its entities in JSON; the Platform stored them directly as values. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { integration } from "../../core/runtime/effect-boundary.js";
import type { DatabaseApi, TenantApi } from "../../db/database.js";
import type { DocumentCursor } from "../../db/document-model.js";
import { AUTH_TENANT_ID, LEGACY_AUTH_SETTINGS_TENANT_ID } from "../../db/naming.js";
import type { ZelavisSystemStore } from "../../system-store.js";
import { GrantSchema } from "../accounts/tables.js";
import { sha256Hex } from "../lib/crypto.js";
import { ACCOUNT_ID_PATTERN } from "../runtime/db.js";

// A password row can use three index reads. Leave room under the 256-read transaction limit.
export const IMPORT_PAGE_SIZE = 64;
export const LegacyAccountId = Schema.String.check(Schema.isPattern(ACCOUNT_ID_PATTERN));
const RecordMetadata = Schema.Record(Schema.String, Schema.Unknown);
const date = Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) ? undefined : "Invalid Identity date"));
const identifier = Schema.String.check(Schema.isBetweenLength(1, 1024));

export const LegacyAccount = Schema.Struct({
  id: LegacyAccountId,
  email: Schema.optional(identifier),
  displayName: Schema.optional(Schema.String),
  verified: Schema.Boolean,
  registrationPending: Schema.optional(Schema.Literal(true)),
  roles: Schema.optional(Schema.Array(Schema.String)),
  permissions: Schema.optional(Schema.Array(Schema.String)),
  grants: Schema.optional(Schema.Array(GrantSchema)),
  accessRevision: Schema.optional(Schema.Natural),
  sessionEpoch: Schema.optional(Schema.Natural),
  metadata: Schema.optional(RecordMetadata),
  createdAt: date,
});

export const LegacyCredential = Schema.Struct({
  id: Schema.String,
  accountId: LegacyAccountId,
  provider: identifier,
  identifier,
  secretHash: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 4096))),
  metadata: Schema.optional(RecordMetadata),
});

export const LegacySession = Schema.Struct({
  id: Schema.String,
  accountId: LegacyAccountId,
  tokenHash: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  status: Schema.Literals(["active", "revoked", "expired"]),
  epoch: Schema.optional(Schema.Natural),
  metadata: Schema.optional(RecordMetadata),
  createdAt: date,
  expiresAt: date,
});

export const LegacyConnection = Schema.Struct({
  provider: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u)),
  issuer: Schema.optional(Schema.String),
  discovered: Schema.optional(Schema.Struct({
    issuer: Schema.String,
    authorizationEndpoint: Schema.String,
    tokenEndpoint: Schema.String,
    jwksUrl: Schema.String,
    algorithms: Schema.optional(Schema.Array(Schema.String)),
  })),
  clientId: identifier,
  clientSecret: Schema.optional(Schema.String),
  redirectUri: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
  enabled: Schema.Boolean,
  updatedAt: date,
  teamId: Schema.optional(Schema.String),
  keyId: Schema.optional(Schema.String),
});

export const LegacyRegistration = Schema.Struct({
  id: Schema.Literal("registration"),
  schemaVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  revision: Schema.Natural,
});

const LegacyBootstrap = Schema.Struct({
  claimId: Schema.String,
  status: Schema.Literals(["pending", "complete", "failed"]),
  createdAt: date,
  updatedAt: date,
});

export function decodeIdentity<S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] | undefined {
  const decoded = Schema.decodeUnknownExit(schema)(value);
  return Exit.isSuccess(decoded) ? decoded.value : undefined;
}
const entityJson = Schema.fromJsonString(Schema.Unknown);

const authNamespace = "zelavis.platform.auth";
const bootstrapNamespace = "zelavis.platform.auth.bootstrap";
const providerNamespace = "zelavis.service:zelavis/identity:oauth";

const collections = {
  accounts: "auth_accounts",
  credentials: "auth_credentials",
  sessions: "auth_sessions",
  connections: "auth_provider_settings",
} as const;
const prefixes = {
  accounts: "account:",
  credentials: "credential:",
  sessions: "session:",
  connections: "connection:",
} as const;

export type IdentityRows = keyof typeof collections;
export interface IdentityPage {
  readonly records: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  readonly next?: string | undefined;
}
export interface IdentitySettings {
  readonly registration?: unknown;
  readonly bootstrapComplete: boolean;
}

export class IdentityImportFailure extends Schema.TaggedError<IdentityImportFailure>()("IdentityImportFailure", {
  message: Schema.String,
}) {}

export interface IdentitySource {
  readonly pages: (kind: IdentityRows, after?: string) => Effect.Effect<IdentityPage, IdentityImportFailure>;
  readonly settings: () => Effect.Effect<IdentitySettings, IdentityImportFailure>;
  /**
   * A digest of every Identity record's key and revision (System Store `updatedAt`, document `version`). It changes
   * exactly when the prior engine writes, which it can do only after a rollback gave it write authority again.
   */
  readonly fingerprint: () => Effect.Effect<string, IdentityImportFailure>;
}

/** Pages a fingerprint reads at a time; it reads keys and revisions, never decodes a record. */
const FINGERPRINT_PAGE_SIZE = 256;

/** Folds one page of `[place, key, revision]` entries into the running digest. */
const foldPage = (digest: string, entries: ReadonlyArray<readonly [string, string, string | number]>) =>
  entries.length === 0 ? Effect.succeed(digest) : sha256Hex(`${digest}\n${JSON.stringify(entries)}`);

const readFailure = (message: string) => () => new IdentityImportFailure({ message });

export function systemStoreIdentitySource(store: ZelavisSystemStore): IdentitySource {
  return {
    pages: (kind, after) => Effect.gen(function* () {
      const prefix = prefixes[kind];
      const namespace = kind === "connections" ? providerNamespace : authNamespace;
      const page = yield* integration(() => store.page(namespace, { limit: IMPORT_PAGE_SIZE, after: after ?? prefix })).pipe(
        Effect.mapError(readFailure(`Could not read Platform Identity ${kind}.`)),
      );
      return {
        records: page.records.filter((row) => row.key.startsWith(prefix)).map((row) => ({
          id: row.key.slice(prefix.length), value: row.value,
        })),
        next: page.next?.startsWith(prefix) ? page.next : undefined,
      };
    }),
    fingerprint: () => Effect.gen(function* () {
      let digest = "";
      for (const namespace of [authNamespace, bootstrapNamespace, providerNamespace]) {
        let after: string | undefined;
        for (;;) {
          const page = yield* integration(() => store.page(namespace, { limit: FINGERPRINT_PAGE_SIZE, ...(after === undefined ? {} : { after }) })).pipe(
            Effect.mapError(readFailure("Could not read Platform Identity records.")),
          );
          digest = yield* foldPage(digest, page.records.map((row) => [namespace, row.key, row.updatedAt] as const));
          if (page.next === undefined) break;
          if (page.next === after) return yield* new IdentityImportFailure({ message: "The Platform Identity source did not return an advancing page." });
          after = page.next;
        }
      }
      return digest;
    }),
    settings: () => Effect.gen(function* () {
      const bootstrap = yield* integration(() => store.get(bootstrapNamespace, "first-owner")).pipe(
        Effect.mapError(readFailure("Could not read the Platform Identity owner claim.")),
      );
      const claim = decodeIdentity(LegacyBootstrap, bootstrap?.value);
      if (bootstrap !== undefined && claim === undefined) {
        return yield* new IdentityImportFailure({ message: "The Platform Identity owner claim is malformed." });
      }
      const registration = yield* integration(() => store.get(authNamespace, "registration")).pipe(
        Effect.mapError(readFailure("Could not read Platform Identity registration settings.")),
      );
      return { registration: registration?.value, bootstrapComplete: claim?.status === "complete" };
    }),
  };
}

function projectSetting(tenant: TenantApi) {
  return Effect.gen(function* () {
    const collection = "auth_registration";
    if (!(yield* tenant.documents.collectionExists(collection))) return undefined;
    return (yield* tenant.documents.findById({ collection, id: "registration" }))?.data;
  });
}

export function projectDatabaseIdentitySource(database: DatabaseApi): IdentitySource {
  const legacy = database.forTenant(AUTH_TENANT_ID);
  const providers = database.forTenant(LEGACY_AUTH_SETTINGS_TENANT_ID);
  return {
    pages: (kind, after) => Effect.gen(function* () {
      const tenant = kind === "connections" ? providers : legacy;
      const collection = collections[kind];
      if (!(yield* tenant.documents.collectionExists(collection))) return { records: [] };
      // The cursor is generated by findPage and checked against the collection on every reopen.
      const page = yield* tenant.documents.findPage({ collection, limit: IMPORT_PAGE_SIZE, after: after as DocumentCursor | undefined });
      return {
        records: page.documents
          .filter((row) => kind !== "connections" || row.id.startsWith(prefixes.connections))
          .map((row) => kind === "connections"
            ? { id: row.id.slice(prefixes.connections.length), value: row.data.value }
            : { id: row.id, value: decodeIdentity(entityJson, row.data.entity) }),
        next: page.next,
      };
    }).pipe(Effect.mapError(readFailure(`Could not read App Identity ${kind}.`))),
    fingerprint: () => Effect.gen(function* () {
      let digest = "";
      const places = [
        [legacy, collections.accounts], [legacy, collections.credentials], [legacy, collections.sessions],
        [legacy, "auth_registration"], [providers, collections.connections],
      ] as const;
      for (const [tenant, collection] of places) {
        if (!(yield* tenant.documents.collectionExists(collection))) continue;
        let after: DocumentCursor | undefined;
        for (;;) {
          const page = yield* tenant.documents.findPage({ collection, limit: FINGERPRINT_PAGE_SIZE, after });
          digest = yield* foldPage(digest, page.documents.map((row) => [collection, row.id, row.version] as const));
          if (page.next === undefined) break;
          after = page.next;
        }
      }
      return digest;
    }).pipe(Effect.mapError(readFailure("Could not read App Identity records."))),
    settings: () => Effect.map(projectSetting(legacy), (registration) => ({ registration, bootstrapComplete: false })),
  };
}
