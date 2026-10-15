import * as Effect from "effect/Effect";
import { gridData, parseEdit, type GridRecord } from "./model.ts";

const prefix = "zelavis:new-ui:drafts:1:";
const maxBytes = 1024 * 1024;
const maxRecords = 250;
const maxAge = 24 * 60 * 60 * 1000;
export type InspectorDraft = { id: string; version: number; text: string };
export type DraftSnapshot = { records: GridRecord[]; inspector?: InspectorDraft };
export type DraftIdentity = { draftScope: unknown; projectId: unknown; tenant: unknown; collection: unknown; kind?: "schema" };

/** Tab-local storage survives hard reloads without concurrent tabs overwriting drafts. */
export function draftJournal(storage: Storage, identity: DraftIdentity, now: () => number = Date.now) {
  if (typeof identity.draftScope !== "string" || !/^[a-f0-9]{64}$/.test(identity.draftScope)) throw new Error("Drafts require an authenticated session partition.");
  const parts = [identity.projectId, identity.tenant, identity.collection];
  if (parts.some(part => typeof part !== "string" || !part || part.length > 256)) throw new Error("Drafts require a Project, Tenant and table.");
  const key = prefix + JSON.stringify([identity.draftScope, ...parts, ...(identity.kind ? [identity.kind] : [])]);
  const validate = (value: unknown): DraftSnapshot => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft journal.");
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== 1 || typeof envelope.updatedAt !== "number" || !Number.isSafeInteger(envelope.updatedAt) || envelope.updatedAt > now() || now() - envelope.updatedAt > maxAge) throw new Error("Draft journal expired or incompatible.");
    if (!Array.isArray(envelope.records) || envelope.records.length > maxRecords) throw new Error("Draft record limit exceeded.");
    const records = gridData(envelope.records).records;
    if (records.some(row => !Number.isSafeInteger(row.version) || Number(row.version) < 0)) throw new Error("Drafts require their original record versions.");
    const inspector = envelope.inspector as Record<string, unknown> | undefined;
    if (inspector !== undefined && (!inspector || typeof inspector !== "object" || typeof inspector.id !== "string" || typeof inspector.text !== "string" || inspector.text.length > 1048576 || !Number.isSafeInteger(inspector.version) || Number(inspector.version) < 0)) throw new Error("Invalid inspector draft.");
    return { records, ...(inspector ? { inspector: { id: String(inspector.id), version: Number(inspector.version), text: String(inspector.text) } } : {}) };
  };
  return {
    read: Effect.try({ try: () => {
      const text = storage.getItem(key);
      if (!text) return { records: [] } as DraftSnapshot;
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Draft storage exceeds its limit.");
      return validate(parseEdit(text));
    }, catch: cause => cause instanceof Error ? cause : new Error("Browser draft storage is unavailable.") }),
    write: (snapshot: DraftSnapshot) => Effect.try({ try: () => {
      if (!snapshot.records.length && !snapshot.inspector) { storage.removeItem(key); return; }
      const envelope = { version: 1, updatedAt: now(), ...snapshot };
      validate(envelope);
      const text = JSON.stringify(envelope);
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Draft storage exceeds its limit; save or discard changes.");
      // Bound all journals in this tab and prune only our expired/invalid entries.
      let total = 0, count = 0;
      for (let index = storage.length - 1; index >= 0; index--) {
        const other = storage.key(index);
        if (!other?.startsWith(prefix) || other === key) continue;
        const saved = storage.getItem(other) ?? "";
        try { validate(parseEdit(saved)); } catch { storage.removeItem(other); continue; }
        total += new TextEncoder().encode(saved).byteLength; count++;
      }
      if (count >= 32 || total + new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("This tab's draft storage is full; save or discard changes in other tables.");
      storage.setItem(key, text);
    }, catch: cause => cause instanceof Error ? cause : new Error("Could not retain drafts across reloads.") }),
    clear: Effect.try({ try: () => storage.removeItem(key), catch: cause => cause }),
  };
}

export const clearDraftJournals = (storage: () => Storage) => Effect.try({ try: () => {
  const target = storage();
  for (let index = target.length - 1; index >= 0; index--) { const key = target.key(index); if (key?.startsWith(prefix)) target.removeItem(key); }
}, catch: cause => cause });
