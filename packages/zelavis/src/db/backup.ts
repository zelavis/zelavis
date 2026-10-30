import { Effect, Stream } from "effect";
import { equals } from "./query.js";
import {
  type DbError,
  type InvalidExport,
  BackupFormatUnsupported,
  BackupTenantMismatch,
  InvalidRestoreMode,
  type TenantMoving,
  TenantNotEmpty,
} from "./errors.js";
import { carried, checkedLimit, EXPORT_MAX_LIMIT, exportPartitionPage, type ExportPage, type ExportPageInput } from "./export-stream.js";
import { MAX_SEQ } from "./keys.js";
import { asSeq, emptyManifest, type IndexManifest, type ObjectIdentity, type Seq } from "./model.js";
import type { ObjectStoreApi } from "./store.js";
import { COLLECTION_NAMESPACE } from "./tenancy.js";
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

/** Every mode a restore has, in the order the docs describe them. */
export const RESTORE_MODES: ReadonlyArray<RestoreMode> = ["empty", "purge", "merge"];

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
  readonly exportTenant: Effect.Effect<TenantBackupV1>;
  /**
   * One page of this tenant as a stream: its records, then every change since, from the cursor the
   * last page gave. See `ExportPage`. Refused with `CursorCompacted` or `LogCompacted` when the log
   * the export was following was cut, and with `StoreError` for a cursor that is not this tenant's.
   */
  readonly exportPage: (input?: ExportPageInput) => Effect.Effect<ExportPage, DbError | InvalidExport>;
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
   * A tenant being moved off this shard refuses the restore (`TenantMoving`),
   * as it refuses every other write.
   */
  readonly restoreTenant: (
    backup: TenantBackupV1,
    options?: RestoreOptions,
  ) => Effect.Effect<
    RestoreResult,
    BackupFormatUnsupported | BackupTenantMismatch | InvalidRestoreMode | TenantNotEmpty | TenantMoving
  >;
}

/** Records a purge retracts per transaction. */
const PURGE_BATCH = 256;

const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export const backupsFor = (store: ObjectStoreApi, tenant: TenantId): BackupsApi => {
  /**
   * Retract every record a backup would carry.
   *
   * Selected by the rule an export uses, so what a purge removes is exactly
   * what a backup would have carried — a restore that cleared less than it
   * replaces would leave records behind that the backup never knew about.
   *
   * A page of records at a time, each page's retractions one transaction, so
   * a large tenant is neither read into memory nor written in one batch. The
   * retractions go into the tenant's log like any other, so projections and
   * time series reading it carry on: they see the records go, then the
   * restored ones arrive, exactly as a rebuild over the whole log would.
   */
  const purge = Effect.gen(function* () {
    let removed = 0;
    let after: Seq | undefined;
    for (;;) {
      const page = yield* store.scanRecords({ ...(after === undefined ? {} : { after }), limit: PURGE_BATCH });
      if (page.length === 0) return removed;
      after = page[page.length - 1]!.seq;
      const doomed = page.filter(({ record }) => record.live && carried(record.identity)).map(({ seq }) => seq);
      if (doomed.length === 0) continue;
      yield* store.transact((txn) => Effect.forEach(doomed, (seq) => txn.retract(seq), { discard: true }));
      removed += doomed.length;
    }
  }).pipe(Effect.orDie);

  return {
    /**
     * Every record the tenant holds, then every event logged since the records
     * began to be read.
     *
     * Built from the export stream (`exportPage`): pages of records read while writes carry
     * on, each with a page of the log, until the entries received are one position's state. A
     * restore applies everything by version, so an event older than the record already exported
     * changes nothing and a newer one brings it forward, and the restored tenant is the tenant as
     * of the last of them. Nothing is held open between pages but the log (`holdLog`), so a large
     * tenant does not pin a read snapshot for the length of the export, and a compaction running
     * meanwhile cannot cut it off. Reading the records rather than the whole log keeps an export
     * the size of what the tenant holds, not of everything it was ever written.
     */
    exportTenant: Effect.gen(function* () {
      const entries: BackupEvent[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = yield* exportPartitionPage(store, { ...(cursor === undefined ? {} : { cursor }), limit: EXPORT_MAX_LIMIT });
        entries.push(...page.entries);
        if (page.consistent) break;
        cursor = page.cursor;
      }
      return {
        format: ZELAVIS_DB_BACKUP_V1,
        exportedAt: new Date().toISOString(),
        tenantId: tenant,
        events: entries,
      };
    }).pipe(Effect.orDie),

    exportPage: (input) =>
      Effect.gen(function* () {
        const limit = yield* checkedLimit(input?.limit);
        const page = yield* exportPartitionPage(store, { ...(input?.cursor === undefined ? {} : { cursor: input.cursor }), limit });
        return { tenantId: tenant, entries: page.entries, cursor: page.cursor, consistent: page.consistent } satisfies ExportPage;
      }),

  restoreTenant: (backup, options) =>
    Effect.gen(function* () {
      if (backup.format !== ZELAVIS_DB_BACKUP_V1) {
        return yield* new BackupFormatUnsupported({ format: String(backup.format) });
      }
      if (backup.tenantId !== tenant) {
        return yield* new BackupTenantMismatch({ expected: tenant, received: backup.tenantId });
      }
      // Identifiers are kept where they can be, so each must be one.
      const malformed = backup.events.find((event) => !Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > MAX_SEQ);
      if (malformed !== undefined) {
        return yield* new BackupFormatUnsupported({ format: `${backup.format} naming identifier ${String(malformed.seq)}` });
      }

      // The label is the only tenant a backup names. The records inside are
      // named within a partition, and a restore writes into this tenant's own,
      // so nothing in a backup can reach another tenant's records.
      const mode = options?.into ?? "empty";
      // Checked here, where the modes are decided, because the options come
      // from HTTP bodies and CLI flags as much as from typed callers.
      if (!RESTORE_MODES.includes(mode)) return yield* new InvalidRestoreMode({ mode: String(mode) });
      if (mode === "empty") {
        const occupied = yield* Stream.runCollect(
          Stream.take(store.resolve(equals(COLLECTION_NAMESPACE, "\u0000collection")), 1),
        );
        if (occupied.length > 0) return yield* new TenantNotEmpty({ tenant });
      }

      // Discarded before anything is replayed, so the tenant is momentarily
      // empty and the replay below is the same one an empty tenant gets.
      // Records the backup does not mention go with the rest: `purge` means the
      // tenant ends up as the backup describes it, not as a union.
      const removed = mode === "purge" ? yield* purge : 0;

      // A backup's identifiers are those of the partition it was taken from,
      // and an empty or purged tenant keeps them: its records come back as the
      // ones they were, edges and all. A retired record at one of them only
      // means its versions start higher. A live one there — a receipt or a
      // checkpoint a purge keeps, from another history than the backup's —
      // would be written over, so then, as in a merge, each identifier is
      // remapped once and the mapping carries retractions and edges along.
      const retiredVersions = new Map<number, number>();
      const liveHeld = new Set<number>();
      if (mode !== "merge") {
        // Reserved before looking, so no write arriving meanwhile can be handed
        // one of them and then be written over, or ignore the backup's record.
        const highest = backup.events.reduce((top, event) => Math.max(top, event.seq), 0);
        if (highest > 0) yield* store.reserve(asSeq(highest));
        yield* Stream.runForEach(store.records, ({ seq, record }) =>
          Effect.sync(() => {
            if (record.live) liveHeld.add(seq);
            else retiredVersions.set(seq, record.version);
          }));
      }
      const verbatim = mode !== "merge" && backup.events.every((event) => event.kind !== "put" || !liveHeld.has(event.seq));
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

      // Every record is given its identifier before any is written, because an
      // edge names its target by identifier: a manifest restored as it was
      // would point at the backup's numbers, which here name some other record
      // or nothing. Assigning first lets an edge reach a target that the
      // backup happens to list after the record naming it.
      for (const event of backup.events) {
        if (event.kind !== "put" || remapped.has(event.seq)) continue;
        if (verbatim) {
          remapped.set(event.seq, asSeq(event.seq));
          const retired = retiredVersions.get(event.seq);
          if (retired !== undefined) lift.set(event.seq, retired);
          continue;
        }
        const identity = event.identity;
        const local = mode === "merge" && identity !== undefined
          ? yield* store.lookup(identity.namespace, identity.key)
          : undefined;
        if (local === undefined) {
          remapped.set(event.seq, yield* store.nextSeq);
        } else {
          remapped.set(event.seq, local);
          const current = yield* store.read(local);
          lift.set(event.seq, current?.version ?? 0);
          superseded += 1;
        }
      }

      for (const event of backup.events) {
        if (event.kind === "put") {
          const identity = event.identity;
          const seq = remapped.get(event.seq)!;
          const manifest = (event.manifest as IndexManifest | undefined) ?? emptyManifest;
          yield* store.events.apply({
            _tag: "ObjectPut",
            partition: store.partition,
            generation: store.generation,
            at: event.at,
            seq,
            version: event.version + (lift.get(event.seq) ?? 0),
            bytes: event.body === undefined ? new Uint8Array() : fromBase64(event.body),
            // An edge to a record the backup does not hold names nothing that
            // exists here, so it is dropped rather than left pointing at
            // whatever this shard gave that number to.
            manifest: {
              ...manifest,
              edges: manifest.edges.flatMap(([edgeType, to]) => {
                const target = remapped.get(to);
                return target === undefined ? [] : [[edgeType, target] as const];
              }),
            },
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
      Effect.catchTags({
        StoreError: Effect.die,
        WriterFenced: Effect.die,
        ForeignCursor: Effect.die,
        CursorCompacted: Effect.die,
        LogCompacted: Effect.die,
        PartitionUnavailable: Effect.die,
        PartitionExhausted: Effect.die,
        LensesRebuilding: Effect.die,
        TenantBranching: Effect.die,
        TenantRelocated: Effect.die,
      }),
    ),
  };
};
