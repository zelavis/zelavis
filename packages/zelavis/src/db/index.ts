/**
 * `zelavis/db` — a multi-model object store.
 *
 * One payload is written once and projected through several index lenses that
 * hold pointers back to a shared, partition-local identifier space. Because
 * every lens addresses the same space, a predicate spanning documents, columns
 * and edges resolves as one sorted-set intersection rather than an exchange
 * between separate engines.
 *
 * Locality is declared, not inferred: see `PartitionKey`.
 */
export * from "./json.js";
export * from "./naming.js";
export * from "./model.js";
export * as Schema from "./schema/index.js";
export * from "./errors.js";
export * from "./query.js";
export * from "./events.js";
export * as Postings from "./postings.js";
export * from "./store.js";
export * from "./gateway.js";
export * from "./keys.js";
export * from "./kv.js";
export * from "./kv-store.js";
export * from "./documents.js";
export * from "./topology.js";
export * from "./domain-events.js";
export * from "./projections.js";
export * from "./schemas.js";
export * from "./time-series.js";
export * from "./tenancy.js";
export * from "./backup.js";
export * from "./topology-store.js";
export * from "./system-views.js";
export * from "./runtime-api.js";
export * from "./database.js";
export * from "./database-service.js";
