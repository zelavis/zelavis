/** Agent-side view of a committed Platform placement. */
export interface AgentPlacementLease {
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
  readonly state: "active" | "released";
  readonly leaseExpiresAt: number;
  /** Platform-authority time measured with the same clock as `leaseExpiresAt`. */
  readonly authorityNow: number;
}

export interface AgentPlacementIdentity {
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
}

export interface AgentPlacementLeaseSupervisor {
  /** Must succeed before starting a process or accepting its writes. */
  start(): Promise<boolean>;
  /** Re-read authority; useful for an explicit foreign-owner notification. */
  check(): Promise<boolean>;
  readonly fenced: boolean;
  close(): void;
}

/**
 * An Agent derives its local deadline from the monotonic time *before* asking
 * Platform authority for the lease. Network time therefore shortens the
 * usable lease; it cannot extend it. Local wall-clock skew has no role.
 */
export function createAgentPlacementLeaseSupervisor(options: {
  readonly identity: AgentPlacementIdentity;
  readonly read: (projectId: string) => Promise<AgentPlacementLease | undefined>;
  readonly onFence: () => Promise<void> | void;
  readonly monotonicNow?: () => number;
  readonly checkIntervalMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}): AgentPlacementLeaseSupervisor {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const checkInterval = Math.max(1, Math.min(options.checkIntervalMs ?? 5_000, 60_000));
  let deadline = Number.NEGATIVE_INFINITY;
  let publishedExpiry = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let expiryTimer: unknown;
  let fenced = false;
  let closed = false;
  let stopped = false;
  let stopping = false;
  let pending: Promise<boolean> | undefined;

  const fence = async () => {
    if (closed || stopped || stopping) return false;
    fenced = true;
    if (timer !== undefined) clearTimer(timer);
    if (expiryTimer !== undefined) clearTimer(expiryTimer);
    timer = undefined;
    expiryTimer = undefined;
    stopping = true;
    try {
      await options.onFence();
      stopped = true;
    } catch {
      // A failed stop does not restore authority. Keep trying to terminate the
      // process until the Agent itself closes and stops its runner.
      if (!closed) timer = setTimer(() => { void fence(); }, 1_000);
    } finally {
      stopping = false;
    }
    return false;
  };

  const schedule = () => {
    if (closed || fenced) return;
    if (timer !== undefined) clearTimer(timer);
    if (expiryTimer !== undefined) clearTimer(expiryTimer);
    const remaining = deadline - monotonicNow();
    timer = setTimer(() => { void check(); }, Math.max(0, Math.min(remaining, checkInterval)));
    expiryTimer = setTimer(() => { void fence(); }, Math.max(0, remaining));
  };

  const check = (): Promise<boolean> => {
    if (closed || fenced) return Promise.resolve(false);
    if (pending) return pending;
    pending = (async () => {
      // The old deadline remains in force while the authority read is pending.
      const requestedAt = monotonicNow();
      if (requestedAt >= deadline && deadline !== Number.NEGATIVE_INFINITY) return fence();
      let lease: AgentPlacementLease | undefined;
      try {
        lease = await options.read(options.identity.projectId);
      } catch {
        return fence();
      }
      if (closed || fenced) return false;
      const expected = options.identity;
      if (!lease || lease.state !== "active" ||
          lease.projectId !== expected.projectId || lease.nodeId !== expected.nodeId ||
          lease.ownerSession !== expected.ownerSession || lease.epoch !== expected.epoch ||
          !Number.isFinite(lease.authorityNow) || !Number.isFinite(lease.leaseExpiresAt) ||
          lease.leaseExpiresAt <= lease.authorityNow) return fence();
      const proposedDeadline = requestedAt + (lease.leaseExpiresAt - lease.authorityNow);
      // A delayed response cannot rescue a lease that expired while in flight.
      if (monotonicNow() >= proposedDeadline) return fence();
      deadline = lease.leaseExpiresAt > publishedExpiry
        ? proposedDeadline
        : Math.min(deadline, proposedDeadline);
      publishedExpiry = Math.max(publishedExpiry, lease.leaseExpiresAt);
      schedule();
      return true;
    })().finally(() => { pending = undefined; });
    return pending;
  };

  return {
    start: check,
    check,
    get fenced() { return fenced; },
    close() {
      closed = true;
      if (timer !== undefined) clearTimer(timer);
      if (expiryTimer !== undefined) clearTimer(expiryTimer);
      timer = undefined;
      expiryTimer = undefined;
    },
  };
}
