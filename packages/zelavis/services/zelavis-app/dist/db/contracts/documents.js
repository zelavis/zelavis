export const DATABASE_COLLECTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const DATABASE_RESERVED_COLLECTION_NAMES = new Set([
    "zv_collections",
    "zv_events",
    "zv_schemas",
    "zv_time_series_checkpoints",
    "zv_time_series_points",
]);
export function validateDatabaseCollectionName(name) {
    if (!DATABASE_COLLECTION_NAME_PATTERN.test(name)) {
        throw new TypeError("Collection names must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens.");
    }
    if (name.startsWith("zv_")) {
        throw new TypeError('Collection names must not start with "zv_" — that prefix is reserved for Zelavis internals.');
    }
    if (DATABASE_RESERVED_COLLECTION_NAMES.has(name)) {
        throw new TypeError(`Collection name "${name}" is reserved.`);
    }
}
