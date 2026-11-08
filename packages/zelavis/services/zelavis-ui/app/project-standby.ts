import { label, object } from "./api.ts";

/**
 * How a lease-guarded Project's standby reads on its page: where it runs and what it is doing, and the reason when it could
 * not be started. A Project without one shows nothing.
 */
export function standbyFact(project: Record<string, unknown>): readonly [string, string] | undefined {
  if (!project.standby) return undefined;
  const standby = object(project.standby);
  const nodeId = label(standby.nodeId);
  switch (standby.status) {
    case "dispatched": return ["Standby", `${nodeId} — standing by`];
    case "promoted": return ["Standby", `${nodeId} — took over as the writer`];
    case "stopped": return ["Standby", `${nodeId} — stopped`];
    case "failed": return ["Standby", `${nodeId} — failed${typeof standby.error === "string" ? `: ${standby.error}` : ""}`];
    default: return ["Standby", `${nodeId} — ${label(standby.status, "unknown")}`];
  }
}

/** A Project process that follows its writer is up but serves nothing, so it reads as standing by, never as running. */
export function runtimeStatusText(status: string): string {
  return status === "standby" ? "standing by" : status;
}
