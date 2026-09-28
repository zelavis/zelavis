/**
 * Provider-neutral contract for a remote environment used by an agent.
 *
 * Zelavis owns the HTTP and SDK boundary; hosts supply the execution
 * implementation. No provider protocol is implied by these types.
 */
export interface ZelavisEnvironmentIdentity {
  readonly id: string;
  readonly name?: string;
  readonly platform?: string;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

export interface ZelavisEnvironmentHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly checkedAt: string;
  readonly message?: string;
}

/** Application scope for a session; lanes are sessions, never child apps. */
export interface ZelavisEnvironmentScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly laneId: string;
}

export interface ZelavisEnvironmentSession {
  readonly id: string;
  /** Monotonic document version used for optimistic lifecycle projections. */
  readonly version?: number;
  readonly status: "active" | "closed";
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly scope?: ZelavisEnvironmentScope;
}

export interface ZelavisEnvironmentProcess {
  readonly id: string;
  readonly sessionId: string;
  readonly status: "starting" | "running" | "exited" | "failed";
  readonly startedAt?: string;
  readonly exitCode?: number;
}

/** Provider-neutral usage reported for one agent run. */
export interface ZelavisEnvironmentUsageInput {
  /** Stable caller-owned run identity; repeated reports merge into it. */
  readonly runId: string;
  readonly source: "provider" | "estimated";
  /** Gauge: how full the context is after this report. */
  readonly contextTokens?: number;
  readonly contextLimit?: number;
  /** Per-run counters. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly premiumRequests?: number;
  readonly model?: string;
}

/** Tenant-owned durable usage projection for one session/run pair. */
export interface ZelavisEnvironmentUsageRecord extends ZelavisEnvironmentUsageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly laneId: string;
  readonly recordedAt: string;
  readonly version: number;
}

/**
 * A replayable process event. The cursor is opaque to callers and stable for
 * the lifetime of the session, so a client can reconnect without guessing
 * which output it already rendered.
 */
export interface ZelavisEnvironmentEvent {
  readonly cursor: string;
  readonly sessionId: string;
  readonly processId?: string;
  readonly type: "stdout" | "stderr" | "status" | "exit";
  readonly timestamp: string;
  readonly data?: string;
  readonly status?: ZelavisEnvironmentProcess["status"];
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ZelavisEnvironmentEventReadOptions {
  readonly after?: string;
  readonly limit?: number;
}

export interface ZelavisEnvironmentEventPage {
  readonly events: readonly ZelavisEnvironmentEvent[];
  /** Cursor of the final returned event, or the supplied cursor when empty. */
  readonly cursor?: string;
  /** True when another immediate read can return more buffered events. */
  readonly hasMore?: boolean;
  /** The requested cursor predates the provider's retained event window. */
  readonly truncated?: boolean;
}

export interface ZelavisEnvironmentSessionInput {
  /** The caller's tenant/project/lane scope, enforced by the environment provider. */
  readonly scope?: ZelavisEnvironmentScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisEnvironmentSessionUpdate {
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Required compare-and-set version from the last read. */
  readonly expectedVersion: number;
}

export interface ZelavisEnvironmentProcessInput {
  readonly command: string;
  /** Working directory for the remote process. */
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisEnvironmentOperationInput {
  readonly type: "stdin" | "signal" | "terminate";
  readonly data?: string;
}

export interface ZelavisEnvironmentOperationResult {
  readonly accepted: boolean;
  readonly process: ZelavisEnvironmentProcess;
}

export interface ZelavisRemoteEnvironment {
  readonly identity: ZelavisEnvironmentIdentity | (() => Promise<ZelavisEnvironmentIdentity> | ZelavisEnvironmentIdentity);
  readonly health: () => Promise<ZelavisEnvironmentHealth> | ZelavisEnvironmentHealth;
  readonly createSession: (
    input: ZelavisEnvironmentSessionInput,
  ) => Promise<ZelavisEnvironmentSession>;
  readonly updateSession?: (
    sessionId: string,
    update: ZelavisEnvironmentSessionUpdate,
  ) => Promise<ZelavisEnvironmentSession>;
  /** Reattaches provider state to a persisted active session after restart. */
  readonly resumeSession?: (
    session: ZelavisEnvironmentSession,
  ) => Promise<ZelavisEnvironmentSession>;
  readonly closeSession?: (
    sessionId: string,
  ) => Promise<void>;
  readonly startProcess: (
    sessionId: string,
    input: ZelavisEnvironmentProcessInput,
  ) => Promise<ZelavisEnvironmentProcess>;
  /**
   * Lists the provider processes currently attached to a session.
   *
   * When supplied, Zelavis uses this after session reattachment to reconcile
   * the tenant's durable process projections with provider reality.
   */
  readonly listProcesses?: (
    sessionId: string,
  ) => Promise<ReadonlyArray<ZelavisEnvironmentProcess>>;
  readonly operateProcess: (
    processId: string,
    input: ZelavisEnvironmentOperationInput,
  ) => Promise<ZelavisEnvironmentOperationResult>;
  /**
   * Reads the durable/bounded event tail for a session. Long-polling or a live
   * stream may be layered on this cursor contract without changing replay.
   */
  readonly readEvents?: (
    sessionId: string,
    options?: ZelavisEnvironmentEventReadOptions,
  ) => Promise<ZelavisEnvironmentEventPage>;
}
