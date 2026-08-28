import { stat } from "node:fs/promises";
import type { DatabaseDriver } from "../app/db/index.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "../system-store.js";

const MIGRATION_NAMESPACE = "app-data-migrations";
const MIGRATION_KEY = "legacy-single-sqlite-v1";
const MIGRATION_VERSION = 1;
const DEFAULT_EVENT_PAGE_SIZE = 250;

interface LegacyDatabaseMigrationState {
  version: number;
  status: "running" | "completed" | "failed";
  source: "legacy-single-sqlite";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  migratedEvents: number;
  migratedTenants: number;
  error?: string;
}

export interface LegacyAppDatabaseMigrationResult {
  status: "not-found" | "empty" | "completed" | "already-completed";
  migratedEvents: number;
  migratedTenants: number;
}

export interface MigrateLegacyAppDatabaseOptions {
  legacyFilename: string;
  systemStore?: ZelavisSystemStore;
  targetDriver: DatabaseDriver;
  physicalDrivers: ReadonlyMap<string, DatabaseDriver>;
  openLegacyDriver(filename: string): DatabaseDriver;
  tenantAliases?: Readonly<Record<string, string>>;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function migrationStoreValue(
  state: LegacyDatabaseMigrationState,
): ZelavisSystemStoreValue {
  return state as unknown as ZelavisSystemStoreValue;
}

function readMigrationState(
  value: ZelavisSystemStoreValue | undefined,
): LegacyDatabaseMigrationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const state = value as unknown as Partial<LegacyDatabaseMigrationState>;
  if (
    state.version !== MIGRATION_VERSION ||
    state.source !== "legacy-single-sqlite" ||
    (state.status !== "running" &&
      state.status !== "completed" &&
      state.status !== "failed")
  ) {
    return undefined;
  }
  return state as LegacyDatabaseMigrationState;
}

async function countEvents(driver: DatabaseDriver): Promise<number> {
  if (!driver.sql) {
    throw new Error("Legacy App database migration requires local SQL inspection.");
  }
  const result = await driver.sql.query({
    statement: "SELECT COUNT(*) AS event_count FROM zv_events",
  });
  const count = result.rows[0]?.event_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Legacy App database returned an invalid event count.");
  }
  return count;
}

async function countTargetEvents(
  physicalDrivers: ReadonlyMap<string, DatabaseDriver>,
  tenantIds: readonly string[],
): Promise<number> {
  let total = 0;
  for (const driver of physicalDrivers.values()) {
    if (!driver.sql) {
      throw new Error("Legacy App database migration requires local SQL inspection.");
    }
    for (const tenantId of tenantIds) {
      const result = await driver.sql.query({
        statement:
          "SELECT COUNT(*) AS event_count FROM zv_events WHERE tenant_id = ?",
        parameters: [tenantId],
      });
      const count = result.rows[0]?.event_count;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error("App shard returned an invalid Tenant event count.");
      }
      total += count;
    }
  }
  return total;
}

async function listLegacyTenants(driver: DatabaseDriver): Promise<string[]> {
  if (!driver.sql) {
    throw new Error("Legacy App database migration requires local SQL inspection.");
  }
  const result = await driver.sql.query({
    statement: `SELECT tenant_id FROM zv_events
      UNION SELECT tenant_id FROM zv_collections
      ORDER BY tenant_id ASC`,
  });
  return result.rows.map((row) => {
    if (typeof row.tenant_id !== "string" || row.tenant_id.length === 0) {
      throw new Error("Legacy App database contains an invalid Tenant ID.");
    }
    return row.tenant_id;
  });
}

function resolveTenantAliases(
  tenants: readonly string[],
  aliases: Readonly<Record<string, string>>,
): Map<string, string> {
  const resolved = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const tenantId of tenants) {
    const targetTenantId = aliases[tenantId] ?? tenantId;
    if (!targetTenantId || targetTenantId.trim() !== targetTenantId) {
      throw new Error(
        `Legacy Tenant "${tenantId}" maps to an invalid Tenant ID.`,
      );
    }
    const owner = owners.get(targetTenantId);
    if (owner && owner !== tenantId) {
      throw new Error(
        `Legacy Tenants "${owner}" and "${tenantId}" both map to "${targetTenantId}". Automatic recovery stopped to avoid merging Tenant data.`,
      );
    }
    owners.set(targetTenantId, tenantId);
    resolved.set(tenantId, targetTenantId);
  }
  return resolved;
}

async function persistState(
  store: ZelavisSystemStore | undefined,
  state: LegacyDatabaseMigrationState,
): Promise<void> {
  await store?.set(
    MIGRATION_NAMESPACE,
    MIGRATION_KEY,
    migrationStoreValue(state),
  );
}

/**
 * Recovers the pre-topology App database by replaying its event source of truth
 * through the current Tenant router. The old file remains untouched as a
 * recovery artifact. A durable marker makes an interrupted replay resumable;
 * target events are accepted only when that marker proves this migration owns
 * the partial data.
 */
export async function migrateLegacyAppDatabase(
  options: MigrateLegacyAppDatabaseOptions,
): Promise<LegacyAppDatabaseMigrationResult> {
  try {
    await stat(options.legacyFilename);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "not-found", migratedEvents: 0, migratedTenants: 0 };
    }
    throw error;
  }

  const storedRecord = await options.systemStore?.get(
    MIGRATION_NAMESPACE,
    MIGRATION_KEY,
  );
  const previousState = readMigrationState(storedRecord?.value);
  const sourceDriver = options.openLegacyDriver(options.legacyFilename);
  const sourceEventCount = await countEvents(sourceDriver);
  const tenants = await listLegacyTenants(sourceDriver);
  const tenantMap = resolveTenantAliases(
    tenants,
    options.tenantAliases ?? {},
  );
  const targetEventCount = await countTargetEvents(
    options.physicalDrivers,
    [...new Set(tenantMap.values())],
  );

  if (
    previousState?.status === "completed" &&
    targetEventCount >= sourceEventCount
  ) {
    return {
      status: "already-completed",
      migratedEvents: previousState.migratedEvents,
      migratedTenants: previousState.migratedTenants,
    };
  }

  if (sourceEventCount > 0 && targetEventCount > 0 && !previousState) {
    throw new Error(
      "Legacy App database recovery found data in both the old database and the new shard topology. Automatic recovery stopped to avoid merging or overwriting data.",
    );
  }

  const startedAt = previousState?.startedAt ?? new Date().toISOString();
  let migratedEvents = previousState?.migratedEvents ?? 0;
  const runningState: LegacyDatabaseMigrationState = {
    version: MIGRATION_VERSION,
    status: "running",
    source: "legacy-single-sqlite",
    startedAt,
    updatedAt: new Date().toISOString(),
    migratedEvents,
    migratedTenants: tenants.length,
  };
  await persistState(options.systemStore, runningState);

  try {
    if (sourceDriver.schemas) {
      if (!options.targetDriver.schemas) {
        throw new Error(
          "The shard topology cannot store schemas required by the legacy App database.",
        );
      }
      const schemas = await sourceDriver.schemas.list();
      for (const schema of schemas) {
        await options.targetDriver.schemas.save(schema);
      }
      for (const schema of schemas) {
        if (schema.active) {
          await options.targetDriver.schemas.activate(
            schema.collection,
            schema.version,
          );
        }
      }
    }

    migratedEvents = 0;
    if (!options.targetDriver.events.restore) {
      throw new Error(
        "The shard topology cannot restore exact events required by the legacy App database.",
      );
    }
    for (const sourceTenantId of tenants) {
      const targetTenantId = tenantMap.get(sourceTenantId)!;
      let after: Awaited<
        ReturnType<DatabaseDriver["events"]["read"]>
      >[number]["cursor"] | undefined;

      while (true) {
        const events = await sourceDriver.events.read({
          tenantId: sourceTenantId,
          ...(after ? { after } : {}),
          limit: DEFAULT_EVENT_PAGE_SIZE,
        });
        if (events.length === 0) {
          break;
        }

        for (const event of events) {
          await options.targetDriver.events.restore({
            tenantId: targetTenantId,
            eventId: event.eventId,
            nodeId: event.nodeId,
            ...(event.idempotencyKey
              ? { idempotencyKey: event.idempotencyKey }
              : {}),
            collection: event.collection,
            ...(event.documentId ? { documentId: event.documentId } : {}),
            type: event.type,
            revision: event.revision,
            timestamp: event.timestamp,
            schemaVersion: event.schemaVersion,
            payload: event.payload,
          });
          migratedEvents += 1;
        }
        after = events.at(-1)!.cursor;
      }
    }

    if (migratedEvents !== sourceEventCount) {
      throw new Error(
        `Legacy App database recovery expected ${sourceEventCount} events but replayed ${migratedEvents}.`,
      );
    }

    const completedAt = new Date().toISOString();
    await persistState(options.systemStore, {
      ...runningState,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      migratedEvents,
    });
    return {
      status: sourceEventCount === 0 ? "empty" : "completed",
      migratedEvents,
      migratedTenants: tenants.length,
    };
  } catch (error) {
    await persistState(options.systemStore, {
      ...runningState,
      status: "failed",
      updatedAt: new Date().toISOString(),
      migratedEvents,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
