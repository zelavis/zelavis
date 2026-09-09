/**
 * Primitives shared by the Platform composition and the modules split out of
 * it: typed domain errors and the request-body and path normalization used by
 * nearly every Platform route.
 *
 * These live here rather than in `index.ts` so extracted modules can use them
 * without importing the composition they are part of.
 */

export class ZelavisDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisDomainError";
  }
}

export class ZelavisValidationError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisValidationError";
  }
}

export class ZelavisConflictError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisConflictError";
  }
}

export function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimSlashes(trimmed);
}

/**
 * Trims leading and trailing `/` by scanning.
 *
 * `/^\/+/` and `/\/+$/` backtrack quadratically on a long run of separators,
 * and these values come from request paths.
 */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(start, end);
}

export function normalizePath(path: string | undefined, fallback: string): string {
  if (path === undefined) {
    return fallback;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "/") {
    return "/";
  }

  const normalized = normalizePathPart(trimmed);
  return normalized ? `/${normalized}` : fallback;
}

export function readBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Typed error mapping and small path/date helpers shared by Platform services
// ---------------------------------------------------------------------------

import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
} from "../core/index.js";
import {
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
} from "../app/auth/index.js";
import type { ZelavisSystemStoreValue } from "../system-store.js";

export type ZelavisRuntimeEngine = "node" | "bun" | "deno";


export function joinPathParts(...parts: (string | undefined)[]): string {
  const normalized = parts.map(normalizePathPart).filter(Boolean);
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

export function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function toIsoDate(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

/**
 * The database fails with schema-tagged errors rather than error classes, so a
 * rule that reaches a database failure here matches its tag. Only the two the
 * Platform's own routes can provoke are listed; the database service maps the
 * full set on its own routes.
 */
function databaseFailureTag(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { _tag?: unknown; cause?: unknown };
  return typeof candidate._tag === "string"
    ? candidate._tag
    : databaseFailureTag(candidate.cause);
}

export const zelavisErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) =>
      error instanceof TypeError ||
      error instanceof AuthValidationError ||
      error instanceof ZelavisValidationError,
    status: 400,
  },
  {
    matches: (error) =>
      error instanceof AuthNotFoundError ||
      databaseFailureTag(error) === "DocumentNotFound" ||
      databaseFailureTag(error) === "CollectionNotFound",
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof ZelavisConflictError ||
      databaseFailureTag(error) === "DocumentConflict",
    status: 409,
  },
  {
    matches: (error) =>
      error instanceof AuthDomainError || error instanceof ZelavisDomainError,
    status: 400,
  },
];

export function zelavisErrorResponse(error: unknown, fallback = 500) {
  return createMappedJsonErrorResponse(error, zelavisErrorRules, fallback);
}

export interface ZelavisKeyValueStore {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<boolean> | boolean;
  list?(prefix?: string): Promise<readonly string[]> | readonly string[];
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isRuntimeEngine(value: unknown): value is ZelavisRuntimeEngine {
  return value === "node" || value === "bun" || value === "deno";
}

export function normalizeEditableRootPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path, "/");
}

export function toSystemStoreValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}
