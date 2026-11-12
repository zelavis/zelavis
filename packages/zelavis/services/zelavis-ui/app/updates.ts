/** What the dashboard says about an update, in one place so the banner and the card agree. */
export type UpdateState = "idle" | "requested" | "running" | "succeeded" | "failed" | "rolled-back";

export interface UpdateStatus {
  current: string;
  channel?: string;
  latest?: string;
  available: boolean;
  checkedAt?: string;
  checkError?: string;
  managed: boolean;
  unmanagedReason?: string;
  state: UpdateState;
  run?: { to?: string; message?: string; log?: readonly string[] };
}

export type UpdateView =
  | { kind: "hidden" }
  | { kind: "available"; latest: string; current: string }
  | { kind: "working"; headline: string; detail?: string }
  | { kind: "done"; headline: string; detail?: string }
  | { kind: "problem"; headline: string; detail?: string; log?: readonly string[] };

export function describeUpdate(status: UpdateStatus | undefined, reconnecting = false): UpdateView {
  if (!status) return reconnecting ? { kind: "working", headline: "Updating Zelavis…", detail: "The dashboard will reconnect by itself." } : { kind: "hidden" };
  const run = status.run;
  if (status.state === "requested") return { kind: "working", headline: `Starting the update${status.latest ? ` to ${status.latest}` : ""}…`, detail: "The server picks it up in a moment." };
  if (status.state === "running") return { kind: "working", headline: run?.message ?? "Updating…", detail: "Running projects keep serving while the engine is replaced." };
  if (status.state === "rolled-back" || status.state === "failed") return { kind: "problem", headline: run?.message ?? "The update did not complete.", ...(run?.log ? { log: run.log } : {}) };
  // Something newer than what just finished takes the place of "done".
  if (status.available && status.latest) return { kind: "available", latest: status.latest, current: status.current };
  if (status.state === "succeeded" && run?.to && run.to === status.current) return { kind: "done", headline: `Updated to ${status.current}.` };
  return { kind: "hidden" };
}

/** Polling gets faster while something is happening, and slows when nothing is. */
export function updatePollDelay(status: UpdateStatus | undefined, reconnecting: boolean): number {
  if (reconnecting || status?.state === "requested" || status?.state === "running") return 2000;
  return 15 * 60_000;
}

export function ago(iso: string | undefined, now = Date.now()) {
  if (!iso) return "not yet";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
