/** The export the earlier engine writes for the data-layout migration: written by `_data-export-worker`, read by `_node-data-migration`. */
import { arrayOf, isJsonObject, isSafeInteger, isString, literal, objectFields, optional } from "../core/json-validation.js";

export const DATA_EXPORT_FORMAT = "zelavis-data-export/2" as const;
/** alpha.25 to alpha.42 read at most this many entries of a shard's log for an export, and stop there silently. */
export const EXPORT_EVENT_CAP = 1_000_000;
/** One event line; a document is base64 inside it. */
export const MAX_EXPORT_LINE_CHARS = 64 * 1024 * 1024;

/** `log`: the Tenant's history in order. `state`: its shard's log was compacted, so one put per live record. */
export type TenantHistory = "log" | "state";
export interface ExportManifest {
  readonly format: typeof DATA_EXPORT_FORMAT;
  readonly tenants: ReadonlyArray<{ readonly tenant: string; readonly file: string; readonly events: number; readonly history: TenantHistory }>;
}
/** The first line of a Tenant's file. */
export interface ExportHeader { readonly tenant: string; readonly history: TenantHistory; readonly events: number }
/** Every other line. The earlier engine's lens manifest is not carried: it names that layout's index keys. */
export interface ExportedEvent {
  readonly kind: "put" | "retract";
  readonly seq: number;
  readonly version: number;
  /** When the earlier engine accepted it, epoch milliseconds. */
  readonly at: number;
  readonly identity?: { readonly namespace: string; readonly key: string } | undefined;
  /** Base64 of the record as the earlier engine stored it; puts only. */
  readonly body?: string | undefined;
}
/** A document as the earlier engine stored it. */
export interface ExportedDocument {
  readonly id: string;
  readonly collection: string;
  readonly data: Record<string, unknown>;
  readonly version: number | undefined;
  readonly createdAt: string | undefined;
  readonly updatedAt: string | undefined;
  readonly expiresAt: string | undefined;
}

const isHistory = literal("log", "state");
const isStamp = (value: unknown): value is number => isSafeInteger(value) && value >= 0;
const isVersion = (value: unknown): value is number => isSafeInteger(value) && value >= 1;
const isTime = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
export const exportManifest = objectFields<ExportManifest>({
  format: literal(DATA_EXPORT_FORMAT),
  tenants: arrayOf(objectFields<ExportManifest["tenants"][number]>({ tenant: isString, file: isString, events: isStamp, history: isHistory })),
});
export const exportHeader = objectFields<ExportHeader>({ tenant: isString, history: isHistory, events: isStamp });
export const exportedEvent = objectFields<ExportedEvent>({
  kind: literal("put", "retract"), seq: isSafeInteger, version: isSafeInteger, at: isStamp,
  identity: optional(objectFields<{ readonly namespace: string; readonly key: string }>({ namespace: isString, key: isString })),
  body: optional(isString),
});
export const exportedDocument = objectFields<ExportedDocument>({
  id: isString, collection: isString, data: isJsonObject,
  version: optional(isVersion), createdAt: optional(isTime), updatedAt: optional(isTime), expiresAt: optional(isString),
});
export const isExportTime = isTime;

/** What two copies of a document must agree on: data, version, expiry, and both times where `timed`. One yardstick for the worker's check and the migration's. */
export const comparableDocument = (d: {
  readonly data: unknown; readonly version: number;
  readonly createdAt?: string | undefined; readonly updatedAt?: string | undefined; readonly expiresAt?: string | undefined;
}, timed: boolean): string => JSON.stringify({
  data: d.data, version: d.version,
  ...(timed ? { createdAt: d.createdAt, updatedAt: d.updatedAt } : {}),
  expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
});
