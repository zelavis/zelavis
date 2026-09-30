/**
 * Reading and retaining the Assistant's audit trail.
 *
 * Records are written by the toolbox (one per tool call and decision) and by the
 * provider settings routes. Nothing here can write or edit one; the reader
 * exists so an operator can answer "what did the Assistant do, for whom, and
 * what was decided" after the fact.
 */
import type { AssistantToolAuditRecord } from "./assistant-tools.js";
import type { ZelavisSystemStore } from "./system-store.js";

export const ASSISTANT_AUDIT_NAMESPACE = "assistant-audit";
export const ASSISTANT_AUDIT_MAX_PAGE = 100;
export const ASSISTANT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;

const DECISIONS = new Set([
  "allowed", "denied", "invalid", "failed", "pending_approval", "executed",
]);

export interface AssistantAuditQuery {
  readonly limit?: number;
  /** The `next` cursor of a previous page. */
  readonly before?: string;
  readonly principalId?: string;
  readonly tool?: string;
  readonly decision?: string;
}

export interface AssistantAuditPage {
  /** Newest first. */
  readonly records: readonly AssistantToolAuditRecord[];
  readonly next?: string;
}

export class AssistantAuditQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantAuditQueryError";
  }
}

function parse(value: unknown): AssistantToolAuditRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<AssistantToolAuditRecord>;
  return typeof record.id === "string" && typeof record.at === "string" &&
      typeof record.principalId === "string" && typeof record.tool === "string" &&
      typeof record.arguments === "string" && typeof record.decision === "string"
    ? (record as AssistantToolAuditRecord)
    : undefined;
}

export function createAssistantAuditReader(store: ZelavisSystemStore) {
  return {
    async list(query: AssistantAuditQuery = {}): Promise<AssistantAuditPage> {
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > ASSISTANT_AUDIT_MAX_PAGE) {
        throw new AssistantAuditQueryError(`limit must be an integer from 1 to ${ASSISTANT_AUDIT_MAX_PAGE}.`);
      }
      if (query.decision !== undefined && !DECISIONS.has(query.decision)) {
        throw new AssistantAuditQueryError("decision is not a known audit decision.");
      }
      const records = (await store.list(ASSISTANT_AUDIT_NAMESPACE))
        .filter((record) => query.before === undefined || record.key < query.before)
        .sort((left, right) => (left.key < right.key ? 1 : -1));

      const page: { key: string; record: AssistantToolAuditRecord }[] = [];
      let more = false;
      for (const stored of records) {
        const record = parse(stored.value);
        if (!record) continue;
        if (query.principalId !== undefined && record.principalId !== query.principalId) continue;
        if (query.tool !== undefined && record.tool !== query.tool) continue;
        if (query.decision !== undefined && record.decision !== query.decision) continue;
        if (page.length === limit) {
          more = true;
          break;
        }
        page.push({ key: stored.key, record });
      }
      return {
        records: page.map((entry) => entry.record),
        ...(more ? { next: page[page.length - 1]!.key } : {}),
      };
    },

    /** Deletes records older than the retention window, a bounded batch at a time. */
    async prune(options: { olderThanMs?: number; now?: number; batch?: number } = {}): Promise<number> {
      const cutoff = (options.now ?? Date.now()) - (options.olderThanMs ?? ASSISTANT_AUDIT_RETENTION_MS);
      const batch = options.batch ?? 500;
      let removed = 0;
      for (const stored of await store.list(ASSISTANT_AUDIT_NAMESPACE)) {
        if (removed >= batch) break;
        const at = Date.parse(stored.key.split("_", 1)[0] ?? "");
        if (Number.isFinite(at) && at < cutoff &&
            await store.delete(ASSISTANT_AUDIT_NAMESPACE, stored.key)) {
          removed += 1;
        }
      }
      return removed;
    },
  };
}
