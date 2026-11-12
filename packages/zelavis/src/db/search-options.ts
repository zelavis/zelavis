import type { HybridSearch, SearchStatistics } from "./document-model.js";

/** Shared by local reads and transport decoding; malformed scores must never become NaN. */
export function readHybridSearch(value: unknown): HybridSearch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("hybrid must be an object.");
  }
  const input = value as Record<string, unknown>;
  const result: { text?: number; vector?: number; k?: number; depth?: number } = {};
  for (const name of ["text", "vector", "k", "depth"] as const) {
    const number = input[name];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
      throw new TypeError(`hybrid.${name} must be a finite non-negative number.`);
    }
    if (name === "depth" && (!Number.isInteger(number) || number < 1 || number > 1000)) {
      throw new TypeError("hybrid.depth must be an integer from 1 to 1000.");
    }
    if (name !== "depth" && number > 1_000_000) throw new TypeError(`hybrid.${name} must be at most 1000000.`);
    result[name] = number;
  }
  return result;
}

export function readSearchStatistics(value: unknown): SearchStatistics {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("statistics must be an object.");
  }
  const input = value as Record<string, unknown>;
  const { documents, length, frequencies } = input;
  if (typeof documents !== "number" || !Number.isSafeInteger(documents) || documents < 0
    || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("statistics.documents and statistics.length must be non-negative safe integers.");
  }
  if (!frequencies || typeof frequencies !== "object" || Array.isArray(frequencies)) {
    throw new TypeError("statistics.frequencies must be an object.");
  }
  const entries = Object.entries(frequencies);
  if (entries.length > 4096) throw new TypeError("statistics may contain at most 4096 term frequencies.");
  for (const [term, count] of entries) {
    if (term.length === 0 || term.length > 4096 || typeof count !== "number"
      || !Number.isSafeInteger(count) || count < 0 || count > documents) {
      throw new TypeError("statistics frequencies must be safe integers from zero to statistics.documents, with non-empty terms up to 4096 characters.");
    }
  }
  return { documents, length, frequencies: Object.fromEntries(entries) as Record<string, number> };
}
