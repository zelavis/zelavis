import { DATABASE_PARTITION_HASH_ALGORITHM } from "./contracts.js";

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
const textEncoder = new TextEncoder();

/**
 * Stable unsigned FNV-1a 32-bit hashing over UTF-8 bytes.
 *
 * This is a protocol function, not a runtime-native hash. Its name and test
 * vectors must change if its byte encoding or algorithm ever changes.
 */
export function hashDatabasePartitionKey(value: string): number {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of textEncoder.encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash;
}

export function encodeDatabasePartitionKey(
  logicalDatabaseId: string,
  tenantId: string,
): string {
  return `${DATABASE_PARTITION_HASH_ALGORITHM}\u001f${logicalDatabaseId.length}:${logicalDatabaseId}\u001f${tenantId.length}:${tenantId}`;
}

export function hashDatabaseTenant(
  logicalDatabaseId: string,
  tenantId: string,
): number {
  return hashDatabasePartitionKey(
    encodeDatabasePartitionKey(logicalDatabaseId, tenantId),
  );
}
