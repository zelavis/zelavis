import type { DatabaseRuntimeApi } from "../db/runtime-api.js";

/**
 * The Platform's identity database: its own `zelavis/db` instance for Platform users' Auth data. It is not the System
 * Store, not an App database and not app-facing, so it is mounted as no route, is not `core.database` and is not in
 * `runtime/config`. A runtime keeps it here, reachable only by internal modules that import this file (Zelavis Auth
 * takes it from here); nothing on the public runtime object names it.
 */
const identityDatabases = new WeakMap<object, DatabaseRuntimeApi>();

export const keepIdentityDatabase = (runtime: object, database: DatabaseRuntimeApi): void => {
  identityDatabases.set(runtime, database);
};

export const identityDatabaseOf = (runtime: object): DatabaseRuntimeApi | undefined => identityDatabases.get(runtime);
