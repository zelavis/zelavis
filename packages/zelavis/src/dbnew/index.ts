/**
 * `zelavis/dbnew` — a multi-model object store.
 *
 * One payload is written once and projected through several index lenses that
 * hold pointers back to a shared, partition-local identifier space. Because
 * every lens addresses the same space, a predicate spanning documents, columns
 * and edges resolves as one sorted-set intersection rather than an exchange
 * between separate engines.
 *
 * Locality is declared, not inferred: see `PartitionKey`.
 */
export * from "./model.js";
export * from "./errors.js";
export * from "./query.js";
export * from "./events.js";
export * as Postings from "./postings.js";
export * from "./store.js";
export * from "./documents.js";
export * from "./topology.js";
export * from "./database.js";
