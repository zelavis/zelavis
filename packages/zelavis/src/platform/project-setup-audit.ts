import { Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

/**
 * Who asked for the secret setup values of a Project, and which.
 *
 * The values themselves are never kept: only the Project, the caller and the value ids. The trail is
 * capped by count and age, so asking repeatedly cannot fill the store.
 */
export const PROJECT_SETUP_AUDIT_NAMESPACE = "projects.setup-audit.v1";
export const MAX_PROJECT_SETUP_AUDIT_RECORDS = 500;
export const PROJECT_SETUP_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export interface ProjectSetupAuditEntry {
  readonly at: number;
  readonly projectId: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly revealed: readonly string[];
}

const asValue = (value: unknown) => value as ZelavisSystemStoreValue;

export const recordSetupReveal = Effect.fn("ProjectSetupAudit.record")(function* (store: ZelavisSystemStore, entry: ProjectSetupAuditEntry) {
  const key = `${String(entry.at).padStart(15, "0")}-${crypto.randomUUID()}`;
  yield* integration(() => store.set(PROJECT_SETUP_AUDIT_NAMESPACE, key, asValue(entry)));
  const records = yield* integration(() => store.list(PROJECT_SETUP_AUDIT_NAMESPACE));
  const expired = records.filter((record) => typeof (record.value as { at?: unknown }).at === "number" && entry.at - (record.value as { at: number }).at > PROJECT_SETUP_AUDIT_RETENTION_MS);
  const surplus = [...records].sort((a, b) => a.key.localeCompare(b.key)).slice(0, Math.max(0, records.length - MAX_PROJECT_SETUP_AUDIT_RECORDS));
  const doomed = new Set([...expired, ...surplus].map((record) => record.key));
  yield* Effect.forEach([...doomed], (doomedKey) => integration(() => store.delete(PROJECT_SETUP_AUDIT_NAMESPACE, doomedKey)), { concurrency: 4, discard: true });
});

/** The reveals of one Project, newest first. */
export const readSetupReveals = Effect.fn("ProjectSetupAudit.read")(function* (store: ZelavisSystemStore, projectId: string, limit = 100) {
  const records = yield* integration(() => store.list(PROJECT_SETUP_AUDIT_NAMESPACE));
  return records
    .filter((record) => (record.value as { projectId?: unknown }).projectId === projectId)
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, limit)
    .map((record) => record.value as unknown as ProjectSetupAuditEntry);
});
