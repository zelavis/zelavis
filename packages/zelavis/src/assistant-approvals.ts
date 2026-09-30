/**
 * Human approval for the Assistant's changes.
 *
 * An approval is a second gate, never a substitute for the first. The caller's
 * permission is checked when the request is made and again when it is approved,
 * against the *stored* arguments, so approving cannot run anything the model
 * did not ask for in those exact terms and cannot outlive a revoked permission.
 *
 * A request is one record with a single decision: the transition out of
 * `pending` is a compare-and-set, so a double click or a replay executes once.
 */
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "./system-store.js";

export type AssistantApprovalStatus =
  | "pending"
  | "running"
  | "denied"
  | "expired"
  | "executed"
  | "failed";

export interface AssistantApproval {
  readonly id: string;
  readonly threadId: string;
  /** The principal whose authority the change runs with; the only one who may decide. */
  readonly principalId: string;
  readonly tool: string;
  /** Exactly what will run, as validated when it was requested. */
  readonly arguments: unknown;
  /** What it does, in the operator's words. */
  readonly label: string;
  readonly target: { readonly kind: string; readonly id: string };
  /** Cannot be undone, so the decision must name the target. */
  readonly irreversible: boolean;
  /**
   * Identifies the exact target as it was when asked (a Project's creation time,
   * for one). A request never applies to a different thing that has since taken
   * the same name.
   */
  readonly fingerprint?: string;
  readonly status: AssistantApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
  /** Short result shown on the card once decided. */
  readonly outcome?: string;
}

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_PENDING_APPROVALS_PER_THREAD = 5;
/** One namespace per thread, so listing or deciding never scans other threads' requests. */
const namespaceOf = (threadId: string) => `assistant-approvals:${threadId}`;

export interface AssistantApprovalStore {
  create(approval: AssistantApproval): Promise<void>;
  get(threadId: string, id: string): Promise<AssistantApproval | undefined>;
  /** Approvals of one thread, newest first. */
  listForThread(threadId: string): Promise<readonly AssistantApproval[]>;
  /**
   * Moves a `pending` approval to another status exactly once.
   * `undefined` means someone else decided first (or it is not pending).
   */
  decide(
    threadId: string,
    id: string,
    next: { status: Exclude<AssistantApprovalStatus, "pending">; outcome?: string },
  ): Promise<AssistantApproval | undefined>;
  /** Removes every request of a thread that is being deleted. */
  deleteForThread(threadId: string): Promise<number>;
  /** Records how a `running` change ended, with its result. */
  finish(
    threadId: string,
    id: string,
    next: { status: "executed" | "failed"; outcome: string },
  ): Promise<AssistantApproval | undefined>;
}

function parse(value: ZelavisSystemStoreValue | undefined): AssistantApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const approval = value as unknown as AssistantApproval;
  return typeof approval.id === "string" && typeof approval.threadId === "string"
    ? approval
    : undefined;
}

export function createAssistantApprovalStore(store: ZelavisSystemStore): AssistantApprovalStore {
  return {
    async create(approval) {
      const { created } = await store.setIfAbsent(
        namespaceOf(approval.threadId), approval.id, approval as unknown as ZelavisSystemStoreValue,
      );
      if (!created) throw new Error("Approval id already exists.");
    },
    async get(threadId, id) {
      return parse((await store.get(namespaceOf(threadId), id))?.value);
    },
    async listForThread(threadId) {
      return (await store.list(namespaceOf(threadId)))
        .map((record) => parse(record.value))
        .filter((approval): approval is AssistantApproval => approval !== undefined)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async decide(threadId, id, next) {
      const record = await store.get(namespaceOf(threadId), id);
      const current = parse(record?.value);
      if (!record || !current || current.status !== "pending") return undefined;
      const decided: AssistantApproval = {
        ...current,
        status: next.status,
        decidedAt: new Date().toISOString(),
        ...(next.outcome ? { outcome: next.outcome } : {}),
      };
      const written = await store.compareAndSet(
        namespaceOf(threadId), id, record.updatedAt,
        decided as unknown as ZelavisSystemStoreValue, record.value,
      );
      return written ? decided : undefined;
    },
    async deleteForThread(threadId) {
      let removed = 0;
      for (const record of await store.list(namespaceOf(threadId))) {
        if (await store.delete(namespaceOf(threadId), record.key)) removed += 1;
      }
      return removed;
    },
    async finish(threadId, id, next) {
      const record = await store.get(namespaceOf(threadId), id);
      const current = parse(record?.value);
      if (!record || !current || current.status !== "running") return undefined;
      const finished: AssistantApproval = { ...current, status: next.status, outcome: next.outcome };
      const written = await store.compareAndSet(
        namespaceOf(threadId), id, record.updatedAt,
        finished as unknown as ZelavisSystemStoreValue, record.value,
      );
      return written ? finished : undefined;
    },
  };
}
