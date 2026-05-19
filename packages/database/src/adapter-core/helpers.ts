import type { DatabaseJson, DatabaseJsonObject } from "../contracts/json.js";

export function cloneJson<T extends DatabaseJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseOptionalJson<T>(
  value: string | null | undefined,
): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

export function parseRequiredJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function generateId(prefix = "doc"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function toTimestampMs(value: number | string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`Invalid timestamp value: ${value}`);
  }

  return timestamp;
}

export function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function payloadText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * In-memory implementation kept for callers that operate on already-parsed
 * documents (e.g. tests / debugging). The hot path in the driver uses the
 * SQL pushdown in `json-query.ts` instead, so this is only the fallback
 * shape for callers that don't go through SQL.
 */
export function readJsonPath(
  data: DatabaseJsonObject,
  path: string,
): DatabaseJson | undefined {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current as DatabaseJson | undefined;
}

export function compareJsonValues(
  left: DatabaseJson | undefined,
  right: DatabaseJson | undefined,
): number {
  if (left === right) {
    return 0;
  }

  if (left === undefined) {
    return -1;
  }

  if (right === undefined) {
    return 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }

  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : 1;
}
