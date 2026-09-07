import { Effect, Stream } from "effect";
import { equals } from "./query.js";
import {
  BackupFormatUnsupported,
  BackupTenantMismatch,
  TenantNotEmpty,
} from "./errors.js";
import { asSeq, emptyManifest, type IndexManifest, type ObjectIdentity, type Seq } from "./model.js";
import type { ObjectStoreApi } from "./store.js";
import { COLLECTION_NAMESPACE_PREFIX, isDerivedNamespace, tenantOf } from "./tenancy.js";
import type { TenantId } from "./topology.js";

export const ZELAVIS_DBNEW_BACKUP_V1 = "zelavis.dbnew-backup.v1" as const;

export interface BackupEvent {
  readonly kind: "put" | "retract";
  readonly seq: number;
  readonly version: number;
  readonly at: number;
  /** Base64; JSON cannot carry bytes. */
  readonly body?: string;
  readonly manifest?: unknown;
  readonly identity?: ObjectIdentity;
}

export interface TenantBackupV1 {
  readonly format: typeof ZELAVIS_DBNEW_BACKUP_V1;
  readonly exportedAt: string;
  readonly tenantId: TenantId;
  readonly events: ReadonlyArray<BackupEvent>;
}

export interface RestoreResult {
  readonly tenantId: TenantId;
  readonly events: number;
}

export interface BackupsApi {
  /**
   * Export a tenant as the slice of the log that produced it.
   *
   * The log is already the source of truth, so a backup is a copy of it rather
   * than a separate rendering of collections, schemas and documents that would
   * have to be kept in step with how they are actually stored.
   */
  readonly exportTenant: () => Effect.Effect<TenantBackupV1>;
  /**
   * Replay a backup into this tenant.
   *
   * Restores under the tenant the backup was taken from, into a tenant holding
   * nothing. Both are checked rather than assumed: a backup carries lens keys
   * naming its own tenant, so replaying it elsewhere would store records that
   * no query for that tenant reaches; and replaying over live data would
   * repoint each key at a new record while leaving the old one indexed.
   */
  readonly restoreTenant: (
    backup: TenantBackupV1,
  ) => Effect.Effect<
    RestoreResult,
    BackupFormatUnsupported | BackupTenantMismatch | TenantNotEmpty
  >;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export const backupsFor = (store: ObjectStoreApi, tenant: TenantId): BackupsApi => ({
  exportTenant: () =>
    Effect.gen(function* () {
      // A retraction carries no identity, so ownership is remembered from the
      // put that established each sequence and applied to the delete that
      // follows it.
      const owners = new Map<number, TenantId>();
      const events: BackupEvent[] = [];
      const raw = yield* Stream.runCollect(store.events.read({ limit: 1_000_000 }));

      for (const event of raw) {
        if (event._tag === "ObjectPut") {
          if (event.identity === undefined) continue;
          if (isDerivedNamespace(event.identity.namespace)) continue;
          const owner = tenantOf(event.identity.namespace, event.identity.key);
          if (owner === undefined) continue;
          owners.set(event.seq, owner);
          if (owner !== tenant) continue;
          events.push({
            kind: "put",
            seq: event.seq,
            version: event.version,
            at: event.at,
            body: toBase64(event.bytes),
            manifest: event.manifest,
            identity: event.identity,
          });
        } else if (owners.get(event.seq) === tenant) {
          events.push({
            kind: "retract",
            seq: event.seq,
            version: event.version,
            at: event.at,
          });
        }
      }

      return {
        format: ZELAVIS_DBNEW_BACKUP_V1,
        exportedAt: new Date().toISOString(),
        tenantId: tenant,
        events,
      };
    }).pipe(Effect.orDie),

  restoreTenant: (backup) =>
    Effect.gen(function* () {
      if (backup.format !== ZELAVIS_DBNEW_BACKUP_V1) {
        return yield* new BackupFormatUnsupported({ format: String(backup.format) });
      }
      if (backup.tenantId !== tenant) {
        return yield* new BackupTenantMismatch({ expected: tenant, received: backup.tenantId });
      }
      const occupied = yield* Stream.runCollect(
        Stream.take(store.resolve(equals(`${COLLECTION_NAMESPACE_PREFIX}${tenant}`, "\u0000collection")), 1),
      );
      if (occupied.length > 0) return yield* new TenantNotEmpty({ tenant });

      // Sequences are allocated per shard, so a backup's are meaningless in the
      // shard it is restored into — several tenants share one, and reusing the
      // original numbers would overwrite whatever else holds them. Each is
      // remapped once and the mapping carries retractions to the right record.
      const remapped = new Map<number, Seq>();
      let applied = 0;

      for (const event of backup.events) {
        if (event.kind === "put") {
          const existing = remapped.get(event.seq);
          const seq = existing ?? (yield* store.nextSeq);
          remapped.set(event.seq, seq);
          const identity = event.identity;
          yield* store.events.apply({
            _tag: "ObjectPut",
            partition: store.partition,
            generation: store.generation,
            at: event.at,
            seq,
            version: event.version,
            bytes: event.body === undefined ? new Uint8Array() : fromBase64(event.body),
            manifest: (event.manifest as IndexManifest | undefined) ?? emptyManifest,
            ...(identity === undefined ? {} : { identity }),
          });
          applied++;
          continue;
        }

        const seq = remapped.get(event.seq);
        if (seq === undefined) continue;
        yield* store.events.apply({
          _tag: "ObjectRetracted",
          partition: store.partition,
          generation: store.generation,
          at: event.at,
          seq: asSeq(seq),
          version: event.version,
        });
        applied++;
      }

      return { tenantId: tenant, events: applied };
    }).pipe(
      Effect.catchTag("StoreError", (cause) => Effect.die(cause)),
      Effect.catchTag("WriterFenced", (cause) => Effect.die(cause)),
      Effect.catchTag("ForeignCursor", (cause) => Effect.die(cause)),
      Effect.catchTag("PartitionUnavailable", (cause) => Effect.die(cause)),
    ),
});
