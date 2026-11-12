/**
 * One backup file for a whole Tenant, divided or not.
 *
 * An undivided Tenant's backup is the ordinary per-partition backup
 * (`zelavis.db-backup.v1`). A divided Tenant's is one of those per part, each
 * labelled with its part's key and each as of a position of its own: the same
 * per-part consistency branching gives, for the same reason (nothing writes
 * across parts atomically). Restoring one writes each part only into its own
 * counterpart, through that part's own restore, so a part's backup can never
 * reach another part's records.
 *
 * The target must be divided into exactly the backup's parts. An `empty`
 * restore checks every part is empty before it writes to any, so a refusal
 * leaves the whole Tenant as it was. Past that check a restore is per part: one
 * cut off after some parts were restored is repeated with `purge` or `merge`.
 */
import { Effect } from "effect";
import {
  type BackupEvent, type RestoreOptions, type RestoreResult, type TenantBackupV1, ZELAVIS_DB_BACKUP_V1,
} from "./backup.js";
import type { DatabaseApi } from "./database.js";
import { BackupFormatUnsupported, BackupTenantMismatch, type DbError, DividedRestoreIncomplete, InvalidExport, TenantNotEmpty } from "./errors.js";
import { partitionKeyFor, type TenantId } from "./topology.js";

export const ZELAVIS_DB_DIVIDED_BACKUP_V1 = "zelavis.db-backup.divided.v1" as const;

export interface DividedTenantBackupV1 {
  readonly format: typeof ZELAVIS_DB_DIVIDED_BACKUP_V1;
  readonly exportedAt: string;
  readonly tenantId: TenantId;
  readonly parts: ReadonlyArray<{ readonly part: string; readonly backup: TenantBackupV1 }>;
}

export type WholeTenantBackup = TenantBackupV1 | DividedTenantBackupV1;

export interface WholeTenantRestoreResult extends RestoreResult {
  /** A divided Tenant's parts, each with what its restore did. */
  readonly parts?: ReadonlyArray<RestoreResult & { readonly part: string }>;
}

/** The Tenant's backup: the ordinary one, or one per part when it is divided. */
export const exportWholeTenant = (db: DatabaseApi, tenant: TenantId) =>
  Effect.gen(function* () {
    const parts = db.topology.subdivision.partsOf(tenant);
    if (parts === undefined) return (yield* db.forTenant(tenant).backups.exportTenant) as WholeTenantBackup;
    const backups: Array<{ readonly part: string; readonly backup: TenantBackupV1 }> = [];
    for (const part of parts) backups.push({ part, backup: yield* db.forPart(tenant, part).backups.exportTenant });
    return { format: ZELAVIS_DB_DIVIDED_BACKUP_V1, exportedAt: new Date().toISOString(), tenantId: tenant, parts: backups } satisfies DividedTenantBackupV1;
  });

const isEvents = (value: unknown): value is ReadonlyArray<BackupEvent> => Array.isArray(value);

/** Restore a whole-Tenant backup into `tenant`, which must be divided as the backup is (or not at all). */
export const restoreWholeTenant = (
  db: DatabaseApi,
  tenant: TenantId,
  backup: WholeTenantBackup,
  options?: RestoreOptions,
): Effect.Effect<WholeTenantRestoreResult, DbError | BackupFormatUnsupported | BackupTenantMismatch | DividedRestoreIncomplete | InvalidExport | TenantNotEmpty | Error> =>
  Effect.gen(function* () {
    const format = (backup as { readonly format?: unknown }).format;
    if (format === ZELAVIS_DB_BACKUP_V1) return yield* db.forTenant(tenant).backups.restoreTenant(backup as TenantBackupV1, options);
    if (format !== ZELAVIS_DB_DIVIDED_BACKUP_V1) return yield* new BackupFormatUnsupported({ format: String(format) });
    const divided = backup as DividedTenantBackupV1;
    if (divided.tenantId !== tenant) return yield* new BackupTenantMismatch({ expected: tenant, received: String(divided.tenantId) });
    const parts = db.topology.subdivision.partsOf(tenant);
    const named = Array.isArray(divided.parts) ? divided.parts.map((entry) => entry?.part) : [];
    if (parts === undefined || parts.length !== named.length || parts.some((part, at) => part !== named[at])) {
      return yield* new InvalidExport({
        reason: `This backup is of "${tenant}" divided into ${named.join(", ") || "nothing"}; restore it into a Tenant divided the same way${parts === undefined ? `, and "${tenant}" is not divided` : `, not into ${parts.join(", ")}`}.`,
      });
    }
    for (const entry of divided.parts) {
      const key = partitionKeyFor(tenant, entry.part);
      if (entry.backup?.tenantId !== key || !isEvents(entry.backup.events)) {
        return yield* new BackupTenantMismatch({ expected: key, received: String(entry.backup?.tenantId) });
      }
    }
    if ((options?.into ?? "empty") === "empty") {
      const held = new Set(yield* db.partitions);
      for (const part of parts) {
        const key = partitionKeyFor(tenant, part);
        if (held.has(key)) return yield* new TenantNotEmpty({ tenant: key });
      }
    }
    const restored: Array<RestoreResult & { readonly part: string }> = [];
    for (const entry of divided.parts) {
      const result = yield* db.forPart(tenant, entry.part).backups.restoreTenant(entry.backup, options).pipe(
        Effect.mapError((error) => restored.length === 0
          ? error
          : new DividedRestoreIncomplete({
            tenant, restored: restored.map((done) => done.part), failedPart: entry.part,
            reason: error instanceof Error ? error.message : String(error),
          })),
      );
      restored.push({ part: entry.part, ...result });
    }
    return {
      tenantId: tenant,
      events: restored.reduce((sum, entry) => sum + entry.events, 0),
      removed: restored.reduce((sum, entry) => sum + entry.removed, 0),
      superseded: restored.reduce((sum, entry) => sum + entry.superseded, 0),
      parts: restored,
    } satisfies WholeTenantRestoreResult;
  });
