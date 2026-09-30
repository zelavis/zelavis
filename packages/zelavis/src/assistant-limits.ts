/**
 * Keeps one caller from spending the installation's model provider account.
 *
 * Every Assistant turn can cost real money and holds a provider connection, and
 * `assistant.use` is a chat permission, not a budget. This is a per-caller
 * sliding window plus a cap on turns in flight, in memory: it bounds a runaway
 * client or a leaked session, not a fleet-wide budget (that needs shared state).
 */
export interface AssistantTurnPermit {
  release(): void;
}

export interface AssistantTurnLimiter {
  /** A permit to run one turn, or how long to wait before asking again. */
  acquire(principalId: string): { permit: AssistantTurnPermit } | { retryAfterSeconds: number };
}

export function createAssistantTurnLimiter(options: {
  readonly turnsPerWindow?: number;
  readonly windowMs?: number;
  readonly maxConcurrent?: number;
  readonly now?: () => number;
} = {}): AssistantTurnLimiter {
  const turnsPerWindow = options.turnsPerWindow ?? 30;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const now = options.now ?? Date.now;
  const started = new Map<string, number[]>();
  const inFlight = new Map<string, number>();

  return {
    acquire(principalId) {
      const at = now();
      const recent = (started.get(principalId) ?? []).filter((time) => at - time < windowMs);
      if ((inFlight.get(principalId) ?? 0) >= maxConcurrent) {
        return { retryAfterSeconds: 5 };
      }
      if (recent.length >= turnsPerWindow) {
        return { retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + windowMs - at) / 1000)) };
      }
      recent.push(at);
      started.set(principalId, recent);
      inFlight.set(principalId, (inFlight.get(principalId) ?? 0) + 1);
      let released = false;
      return {
        permit: {
          release() {
            if (released) return;
            released = true;
            const remaining = (inFlight.get(principalId) ?? 1) - 1;
            if (remaining <= 0) inFlight.delete(principalId);
            else inFlight.set(principalId, remaining);
          },
        },
      };
    },
  };
}
