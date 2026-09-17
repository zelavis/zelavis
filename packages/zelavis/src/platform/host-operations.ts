/**
 * Issuing authority for release-signed host operations.
 *
 * The Platform is the only holder of the Ed25519 key an Agent trusts, so this
 * is the one place an envelope can come from. It issues one only when the
 * caller holds the permission the operation's *signed* manifest names, for
 * the scope that manifest names, and only for arguments that manifest accepts.
 * Every issuance is recorded before the Agent sees the request; argument
 * values are not stored, only their digest.
 *
 * There is still no general command runner: an operation that is not
 * installed on the Agent, or whose manifest declares no authorization, cannot
 * be requested at all.
 */
import {
  hostOperationArgumentsDigest,
  signAgentAuthority,
  type ZelavisAgentOperationSummary,
} from "../core/agent/index.js";
import {
  validateHostOperationRequest,
  ZelavisHostOperationValidationError,
  type ZelavisHostOperationManifest,
  type ZelavisHostOperationRequest,
} from "../core/deployment/index.js";
import {
  principalHasPermission,
} from "../core/runtime/request-dispatcher.js";
import type { ZelavisPrincipal } from "../core/runtime/contracts.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const AUDIT_NAMESPACE = "host-operation-audit";
const DEFAULT_DEADLINE_MS = 5 * 60_000;
const MAX_DEADLINE_MS = 15 * 60_000;
const AUTHORITY_LIFETIME_MS = 60_000;

/** The Agent as the broker needs it: the socket client implements this. */
export interface ZelavisHostOperationAgent {
  hostOperationCatalog(): Promise<{
    readonly agentId: string;
    readonly operations: readonly ZelavisHostOperationManifest[];
  }>;
  submitHostOperation(request: ZelavisHostOperationRequest): Promise<ZelavisAgentOperationSummary>;
  getHostOperation(operationId: string): Promise<ZelavisAgentOperationSummary | undefined>;
}

export interface ZelavisPlatformAuthoritySigner {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

export interface ZelavisHostOperationCatalogEntry {
  readonly operation: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly authorization: NonNullable<ZelavisHostOperationManifest["authorization"]>;
  readonly arguments: ZelavisHostOperationManifest["arguments"];
  readonly result?: ZelavisHostOperationManifest["result"];
}

export interface ZelavisHostOperationSubmitInput {
  readonly operation: string;
  /** Required when more than one version is installed. */
  readonly version?: string;
  readonly projectId?: string;
  readonly arguments?: Readonly<Record<string, string>>;
  /** Milliseconds from now; default 5 minutes, at most 15. */
  readonly deadlineMs?: number;
}

export interface ZelavisHostOperationRecord {
  readonly operationId: string;
  readonly operation: string;
  readonly version: string;
  readonly projectId?: string;
  readonly actorId: string;
  readonly argumentNames: readonly string[];
  readonly argumentsDigest: string;
  readonly requestedAt: string;
  /** The Agent's view, when it could be read. */
  readonly agent?: ZelavisAgentOperationSummary;
}

export interface ZelavisHostOperationAuditQuery {
  /** Project-scoped audit; omit for the installation-wide audit. */
  readonly projectId?: string;
  /** Newest first; default 100, at most 500. */
  readonly limit?: number;
}

/**
 * Per-actor submission budget: a token bucket refilled continuously. Limits
 * one principal (or a stolen session) from flooding the Agent; it is per
 * Platform process, not a distributed quota.
 */
export interface ZelavisHostOperationRateLimit {
  readonly submissionsPerMinute: number;
  readonly burst: number;
}

export const DEFAULT_HOST_OPERATION_RATE_LIMIT: ZelavisHostOperationRateLimit =
  Object.freeze({ submissionsPerMinute: 30, burst: 10 });

export interface ZelavisHostOperationBroker {
  catalog(principal: ZelavisPrincipal | undefined): Promise<readonly ZelavisHostOperationCatalogEntry[]>;
  submit(input: ZelavisHostOperationSubmitInput, principal: ZelavisPrincipal | undefined): Promise<ZelavisHostOperationRecord>;
  get(operationId: string, principal: ZelavisPrincipal | undefined): Promise<ZelavisHostOperationRecord>;
  /**
   * Issuance records, never argument values. Installation-wide needs
   * `server.host-operations.audit` (system); a Project's needs
   * `project.host-operations.audit` for that Project.
   */
  audit(
    query: ZelavisHostOperationAuditQuery,
    principal: ZelavisPrincipal | undefined,
  ): Promise<readonly ZelavisHostOperationRecord[]>;
}

export class ZelavisHostOperationRateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Too many host operation requests; retry in ${retryAfterSeconds} s.`);
    this.name = "ZelavisHostOperationRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ZelavisHostOperationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisHostOperationNotFoundError";
  }
}

export class ZelavisHostOperationForbiddenError extends Error {
  readonly status: 401 | 403;
  constructor(message: string, status: 401 | 403 = 403) {
    super(message);
    this.name = "ZelavisHostOperationForbiddenError";
    this.status = status;
  }
}

function allowed(
  principal: ZelavisPrincipal | undefined,
  authorization: NonNullable<ZelavisHostOperationManifest["authorization"]>,
  projectId: string | undefined,
): boolean {
  return principalHasPermission(
    principal,
    authorization.permission,
    authorization.scope === "project"
      ? { type: "project", projectId }
      : { type: "system" },
  );
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createHostOperationBroker(options: {
  readonly agent: ZelavisHostOperationAgent;
  readonly signer: ZelavisPlatformAuthoritySigner;
  readonly store: ZelavisSystemStore;
  readonly now?: () => number;
  /** `false` disables limiting (tests, trusted automation hosts). */
  readonly rateLimit?: ZelavisHostOperationRateLimit | false;
}): ZelavisHostOperationBroker {
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimit === false
    ? undefined
    : options.rateLimit ?? DEFAULT_HOST_OPERATION_RATE_LIMIT;
  if (
    rateLimit &&
    (!(rateLimit.submissionsPerMinute > 0) || !Number.isSafeInteger(rateLimit.burst) || rateLimit.burst < 1)
  ) {
    throw new TypeError("Host operation rate limit needs a positive rate and burst.");
  }
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  const MAX_TRACKED_ACTORS = 10_000;

  /** Takes one token for the actor or throws with the wait until the next. */
  function consumeSubmission(actorId: string) {
    if (!rateLimit) return;
    const at = now();
    const perMs = rateLimit.submissionsPerMinute / 60_000;
    const bucket = buckets.get(actorId) ?? { tokens: rateLimit.burst, updatedAt: at };
    bucket.tokens = Math.min(rateLimit.burst, bucket.tokens + (at - bucket.updatedAt) * perMs);
    bucket.updatedAt = at;
    if (bucket.tokens < 1) {
      buckets.set(actorId, bucket);
      throw new ZelavisHostOperationRateLimitedError(Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1_000)));
    }
    bucket.tokens -= 1;
    // Bounded memory: full buckets carry no state worth keeping.
    if (buckets.size >= MAX_TRACKED_ACTORS && !buckets.has(actorId)) {
      for (const [id, entry] of buckets) {
        if (entry.tokens + (at - entry.updatedAt) * perMs >= rateLimit.burst) buckets.delete(id);
      }
    }
    buckets.set(actorId, bucket);
  }

  async function requestable() {
    const catalog = await options.agent.hostOperationCatalog();
    return {
      agentId: catalog.agentId,
      operations: catalog.operations.filter(
        (manifest): manifest is ZelavisHostOperationManifest & {
          authorization: NonNullable<ZelavisHostOperationManifest["authorization"]>;
        } => manifest.authorization !== undefined,
      ),
    };
  }

  const requireAuthenticated = (principal: ZelavisPrincipal | undefined) => {
    if (!principal || principal.type === "anonymous") {
      throw new ZelavisHostOperationForbiddenError("Authentication required.", 401);
    }
  };

  return {
    async catalog(principal) {
      requireAuthenticated(principal);
      const { operations } = await requestable();
      // Listed if the caller could request it for some scope it holds: the
      // top-level permission, or any grant of that permission.
      return operations
        .filter((manifest) =>
          principal!.permissions?.includes("*") ||
          principal!.permissions?.includes(manifest.authorization.permission) ||
          principal!.grants?.some((grant) =>
            grant.permission === "*" || grant.permission === manifest.authorization.permission))
        .map((manifest) => ({
          operation: manifest.id,
          version: manifest.version,
          artifactDigest: manifest.sha256,
          authorization: manifest.authorization,
          arguments: manifest.arguments,
          ...(manifest.result ? { result: manifest.result } : {}),
        }));
    },

    async submit(input, principal) {
      requireAuthenticated(principal);
      if (!input || typeof input.operation !== "string") {
        throw new ZelavisHostOperationValidationError("A host operation name is required.");
      }
      const { agentId, operations } = await requestable();
      const candidates = operations.filter((manifest) =>
        manifest.id === input.operation &&
        (input.version === undefined || manifest.version === input.version));
      if (candidates.length === 0) {
        throw new ZelavisHostOperationNotFoundError(
          `Host operation "${input.operation}"${input.version ? ` ${input.version}` : ""} is not installed or cannot be requested.`,
        );
      }
      if (candidates.length > 1) {
        throw new ZelavisHostOperationValidationError(
          `Host operation "${input.operation}" has several installed versions; name one.`,
        );
      }
      const manifest = candidates[0]!;
      if (manifest.authorization.scope === "project" && !input.projectId) {
        throw new ZelavisHostOperationValidationError(
          `Host operation "${manifest.id}" is Project-scoped and requires a projectId.`,
        );
      }
      if (manifest.authorization.scope === "system" && input.projectId !== undefined) {
        throw new ZelavisHostOperationValidationError(
          `Host operation "${manifest.id}" is system-scoped and does not accept a projectId.`,
        );
      }
      if (!allowed(principal, manifest.authorization, input.projectId)) {
        throw new ZelavisHostOperationForbiddenError(
          `Missing permission "${manifest.authorization.permission}" for this ${manifest.authorization.scope}.`,
        );
      }
      // After authorization, so unauthorized callers cannot drain someone
      // else's budget, and before anything is signed or recorded.
      consumeSubmission(principal!.id);
      const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1_000 || deadlineMs > MAX_DEADLINE_MS) {
        throw new ZelavisHostOperationValidationError("deadlineMs must be between 1 second and 15 minutes.");
      }
      const issuedAt = now();
      const unsigned: ZelavisHostOperationRequest = {
        operationId: `hostop_${randomHex(16)}`,
        operation: manifest.id,
        version: manifest.version,
        artifactDigest: manifest.sha256,
        authority: "pending",
        arguments: { ...(input.arguments ?? {}) },
        deadline: new Date(issuedAt + deadlineMs).toISOString(),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      };
      // Same validation the Agent applies, before anything is signed.
      const validated = validateHostOperationRequest(unsigned, manifest, issuedAt);
      const argumentsDigest = await hostOperationArgumentsDigest(validated.arguments);
      const authority = await signAgentAuthority(options.signer.privateKey, {
        keyId: options.signer.keyId,
        agentId,
        operationId: validated.operationId,
        operation: validated.operation,
        version: validated.version,
        artifactDigest: validated.artifactDigest,
        argumentsDigest,
        ...(validated.projectId !== undefined ? { projectId: validated.projectId } : {}),
        actorId: principal!.id,
        issuedAt,
        // Long enough to reach the Agent, never longer than the operation.
        expiresAt: issuedAt + Math.min(AUTHORITY_LIFETIME_MS, deadlineMs),
        nonce: randomHex(16),
      });
      const record: ZelavisHostOperationRecord = {
        operationId: validated.operationId,
        operation: validated.operation,
        version: validated.version,
        ...(validated.projectId !== undefined ? { projectId: validated.projectId } : {}),
        actorId: principal!.id,
        argumentNames: Object.keys(validated.arguments).sort(),
        argumentsDigest,
        requestedAt: new Date(issuedAt).toISOString(),
      };
      // Recorded before the Agent sees it: an issued envelope always has an
      // audit entry, even if submission then fails.
      await options.store.setIfAbsent(
        AUDIT_NAMESPACE,
        record.operationId,
        JSON.parse(JSON.stringify(record)) as ZelavisSystemStoreValue,
      );
      const agentSummary = await options.agent.submitHostOperation({ ...validated, authority });
      return { ...record, agent: agentSummary };
    },

    async audit(query, principal) {
      requireAuthenticated(principal);
      const limit = query?.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new ZelavisHostOperationValidationError("limit must be between 1 and 500.");
      }
      const projectId = query?.projectId;
      const permitted = projectId === undefined
        ? principalHasPermission(principal, "server.host-operations.audit", { type: "system" })
        : principalHasPermission(principal, "project.host-operations.audit", { type: "project", projectId });
      if (!permitted) {
        throw new ZelavisHostOperationForbiddenError(
          projectId === undefined
            ? 'Missing permission "server.host-operations.audit".'
            : 'Missing permission "project.host-operations.audit" for this project.',
        );
      }
      // Whole-namespace read: fine at current volumes, a known gap until the
      // System Store offers indexed, paginated listing.
      return (await options.store.list(AUDIT_NAMESPACE))
        .map((entry) => entry.value as unknown as ZelavisHostOperationRecord)
        .filter((record) => projectId === undefined || record.projectId === projectId)
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .slice(0, limit);
    },

    async get(operationId, principal) {
      requireAuthenticated(principal);
      const stored = typeof operationId === "string" && /^hostop_[a-f0-9]{32}$/.test(operationId)
        ? await options.store.get(AUDIT_NAMESPACE, operationId)
        : undefined;
      const record = stored?.value as unknown as ZelavisHostOperationRecord | undefined;
      if (!record) {
        throw new ZelavisHostOperationNotFoundError(`Host operation "${operationId}" was not found.`);
      }
      // Readable by its requester, or by whoever may request it for that scope.
      if (record.actorId !== principal!.id) {
        const { operations } = await requestable();
        const manifest = operations.find((candidate) =>
          candidate.id === record.operation && candidate.version === record.version);
        if (!manifest || !allowed(principal, manifest.authorization, record.projectId)) {
          // Same answer as absent: existence is not disclosed to the unauthorized.
          throw new ZelavisHostOperationNotFoundError(`Host operation "${operationId}" was not found.`);
        }
      }
      const agent = await options.agent.getHostOperation(operationId);
      return { ...record, ...(agent ? { agent } : {}) };
    },
  };
}
