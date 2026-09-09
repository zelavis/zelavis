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

export const ZELAVIS_DB_BACKUP_V1 = "zelavis.db-backup.v1" as const;

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
  readonly format: typeof ZELAVIS_DB_BACKUP_V1;
  readonly exportedAt: string;
  readonly tenantId: TenantId;
  readonly events: ReadonlyArray<BackupEvent>;
}

/**
 * What to do about data the tenant already holds.
 *
 * Restoring is not one operation. Putting a tenant back as it was and folding a
 * copy of it into what is there now are different intentions with different
 * right answers, and a restore that guessed would be wrong half the time.
 */
export type RestoreMode =
  /**
   * Refuse unless the tenant holds nothing.
   *
   * The default, because it is the only mode that cannot lose anything: the
   * caller is told there is data here rather than having it purged or written
   * over.
   */
  | "empty"
  /**
   * Discard what the tenant holds, then restore.
   *
   * The tenant ends up as the backup describes it — including records the
   * backup does not mention, which are gone.
   */
  | "purge"
  /**
   * Restore over what is there, record by record.
   *
   * A record the backup carries supersedes the local one of the same name; a
   * record only held locally is left alone. The backup's history for a
   * superseded record is appended as further versions rather than replacing the
   * local ones, because the local history happened and a restore is not
   * entitled to say it did not.
   */
  | "merge";

export interface RestoreOptions {
  /** Defaults to `empty`. */
  readonly into?: RestoreMode;
}

export interface RestoreResult {
  readonly tenantId: TenantId;
  readonly events: number;
  /** Records discarded before restoring. Only `purge` removes anything. */
  readonly removed: number;
  /** Records the backup wrote over rather than created. Only `merge` does. */
  readonly superseded: number;
}

export interface BackupsApi {
  /**
   * Export a tenant.
   *
   * Taken from the log where the log is whole, because a copy of it needs no
   * separate rendering of collections, schemas and documents to keep in step
   * with how they are stored. Where compaction has removed the beginning, the
   * export is synthesized from current state instead: one put per live record,
   * carrying the version it holds now. That loses the history compaction
   * already discarded and nothing else — but it is why the export cannot simply
   * read whatever events remain, which would restore a tenant missing every
   * record whose creation was compacted away.
   */
  readonly exportTenant: () => Effect.Effect<TenantBackupV1>;
  /**
   * Replay a backup into this tenant.
   *
   * Restores under the tenant the backup was taken from — checked rather than
   * assumed, because a backup carries lens keys naming its own tenant, so
   * replaying it elsewhere would store records that no query for that tenant
   * reaches.
   *
   * What happens to data already there is the caller's to choose. The default
   * refuses, because replaying blindly over live data would repoint each name
   * at a new record while leaving the old one indexed — matching queries,
   * reachable by nothing. `purge` and `merge` are the two coherent answers.
   */
  readonly restoreTenant: (
    backup: TenantBackupV1,
    options?: RestoreOptions,
  ) => Effect.Effect<
    RestoreResult,
    BackupFormatUnsupported | BackupTenantMismatch | TenantNotEmpty
  >;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export const backupsFor = (store: ObjectStoreApi, tenant: TenantId): BackupsApi => {
  /** One put per live record, for a log that no longer reaches back far enough. */
  const exportFromState = () =>
    Effect.gen(function* () {
      const events: BackupEvent[] = [];
      for (const record of yield* store.liveRecords) {
        const owner = tenantOf(record.identity.namespace, record.identity.key);
        if (owner !== tenant) continue;
        if (isDerivedNamespace(record.identity.namespace)) continue;
        events.push({
          kind: "put",
          seq: record.seq,
          version: record.version,
          at: Date.now(),
          body: toBase64(record.bytes),
          manifest: record.manifest,
          identity: record.identity,
        });
      }
      return {
        format: ZELAVIS_DB_BACKUP_V1,
        exportedAt: new Date().toISOString(),
        tenantId: tenant,
        events,
      };
    }).pipe(Effect.orDie);

  /**
   * Retract every record belonging to this tenant.
   *
   * Selected by the rule an export uses, so what a purge removes is exactly
   * what a backup would have carried — a restore that cleared less than it
   * replaces would leave records behind that the backup never knew about.
   */
  const purge = Effect.gen(function* () {
    const doomed = (yield* store.liveRecords).filter((record) =>
      tenantOf(record.identity.namespace, record.identity.key) === tenant
      && !isDerivedNamespace(record.identity.namespace));
    for (const record of doomed) {
      yield* store.transact((txn) => txn.retract(asSeq(record.seq)));
    }
    return doomed.length;
  }).pipe(Effect.orDie);

  return {
  exportTenant: () =>
    Effect.gen(function* () {
      const compactedTo = yield* store.compactedTo;
      if (compactedTo > 0) return yield* exportFromState();

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
        format: ZELAVIS_DB_BACKUP_V1,
        exportedAt: new Date().toISOString(),
        tenantId: tenant,
        events,
      };
    }).pipe(Effect.orDie),

  restoreTenant: (backup, options) =>
    Effect.gen(function* () {
      if (backup.format !== ZELAVIS_DB_BACKUP_V1) {
        return yield* new BackupFormatUnsupported({ format: String(backup.format) });
      }
      if (backup.tenantId !== tenant) {
        return yield* new BackupTenantMismatch({ expected: tenant, received: backup.tenantId });
      }

      // The label on a backup says which tenant it is for; the identities
      // inside say which tenant it is *of*. They can disagree — a hand-edited
      // or hand-assembled backup — and under `empty` that only ever stored
      // records no query for this tenant reached. A merge looks names up to
      // decide what to write over, so the same disagreement would write over
      // another tenant's records on the same shard. Checked once, for every
      // mode, rather than defended against in the one that made it dangerous.
      for (const event of backup.events) {
        const identity = event.identity;
        if (identity === undefined) continue;
        const owner = tenantOf(identity.namespace, identity.key);
        if (owner !== undefined && owner !== tenant) {
          return yield* new BackupTenantMismatch({ expected: tenant, received: owner });
        }
      }

      const mode = options?.into ?? "empty";
      if (mode === "empty") {
        const occupied = yield* Stream.runCollect(
          Stream.take(store.resolve(equals(`${COLLECTION_NAMESPACE_PREFIX}${tenant}`, "\u0000collection")), 1),
        );
        if (occupied.length > 0) return yield* new TenantNotEmpty({ tenant });
      }

      // Discarded before anything is replayed, so the tenant is momentarily
      // empty and the replay below is the same one an empty tenant gets.
      // Records the backup does not mention go with the rest: `purge` means the
      // tenant ends up as the backup describes it, not as a union.
      const removed = mode === "purge" ? yield* purge : 0;

      // Sequences are allocated per shard, so a backup's are meaningless in the
      // shard it is restored into — several tenants share one, and reusing the
      // original numbers would overwrite whatever else holds them. Each is
      // remapped once and the mapping carries retractions to the right record.
      const remapped = new Map<number, Seq>();
      /**
       * How far to lift a restored record's versions.
       *
       * Zero for anything created here. For a record `merge` is writing over,
       * the local version it had: the backup's versions start again at one, and
       * a put that is not newer than what is stored is ignored by design — the
       * same rule that lets a replica re-consume a range it has already seen.
       */
      const lift = new Map<number, number>();
      let applied = 0;
      let superseded = 0;

      for (const event of backup.events) {
        if (event.kind === "put") {
          const identity = event.identity;
          let seq = remapped.get(event.seq);
          if (seq === undefined) {
            const local = mode === "merge" && identity !== undefined
              ? yield* store.lookup(identity.namespace, identity.key)
              : undefined;
            if (local === undefined) {
              seq = yield* store.nextSeq;
            } else {
              seq = local;
              const current = yield* store.read(local);
              lift.set(event.seq, current?.version ?? 0);
              superseded += 1;
            }
            remapped.set(event.seq, seq);
          }
          yield* store.events.apply({
            _tag: "ObjectPut",
            partition: store.partition,
            generation: store.generation,
            at: event.at,
            seq,
            version: event.version + (lift.get(event.seq) ?? 0),
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
          version: event.version + (lift.get(event.seq) ?? 0),
        });
        applied++;
      }

      return { tenantId: tenant, events: applied, removed, superseded };
    }).pipe(
      Effect.catchTag("StoreError", (cause) => Effect.die(cause)),
      Effect.catchTag("WriterFenced", (cause) => Effect.die(cause)),
      Effect.catchTag("ForeignCursor", (cause) => Effect.die(cause)),
      Effect.catchTag("CursorCompacted", (cause) => Effect.die(cause)),
      Effect.catchTag("LogCompacted", (cause) => Effect.die(cause)),
      Effect.catchTag("PartitionUnavailable", (cause) => Effect.die(cause)),
    ),
  };
};
