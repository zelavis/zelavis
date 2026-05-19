import type { DatabaseJson } from "../contracts/json.js";

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
