import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../runtime/effect-boundary.js";
import {
  resolveTrustedEd25519Key,
  type ZelavisHostOperationTrustStore,
} from "../deployment/index.js";
import type { ZelavisSystemStore } from "../../system-store.js";

const CONTEXT = "zelavis-project-dispatch-v1\n";

export interface ProjectDispatchClaims {
  readonly keyId: string;
  readonly agentId: string;
  readonly action: "prepare" | "start" | "stop" | "standby" | "route";
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly artifactDigest?: string;
  /** For `route`: the one request the Agent forwards to the Project, as the Platform's Gateway made it. Signed with the rest. */
  readonly route?: ProjectRouteClaims;
  /** The lease environment the started process gets (`ZELAVIS_LEASE_*`). Signed with the rest, so it cannot be altered in flight. */
  readonly lease?: Readonly<Record<string, string>>;
  /** The App shard channel environment the started process gets (`ZELAVIS_APP_SHARDS_*`). Signed with the rest. */
  readonly appShards?: Readonly<Record<string, string>>;
}

/**
 * The Agent workload a Project's standby process runs as. It is deliberately not the Project's own workload id: the Agent
 * binds every Project workload to the committed placement of its Node and fences the process when that lapses, and a
 * standby has none (the Project's placement is the writer's). The writer lease is the standby's write fence.
 */
export const standbyWorkloadId = (projectId: string): string => `${projectId}#standby`;
export const isStandbyWorkload = (workloadId: string): boolean => workloadId.endsWith("#standby");

/**
 * One request to a Project on another Node, as the Platform's Gateway made it: the method, the path inside the Project
 * runtime, and the caller's claims, which the Agent turns into the Project's own Gateway envelope (it holds that Project's
 * secret; the Platform does not). Bound to the signature, so the Agent forwards nothing but what the Platform signed.
 */
export interface ProjectRouteClaims {
  readonly method: string;
  /** Path and query inside the Project runtime, starting with `/`. */
  readonly path: string;
  readonly gateway: {
    readonly projectId: string;
    readonly scopeId: string;
    readonly generation: number;
    readonly runtimeNodeId: string;
    readonly subject: string;
    readonly subjectType: string;
    readonly tenantId: string;
    readonly permissions: readonly string[];
    readonly accountAccessDigest?: string;
  };
}

const ROUTE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const validRoute = (value: unknown): value is ProjectRouteClaims => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  const gateway = route.gateway as Record<string, unknown> | undefined;
  return typeof route.method === "string" && ROUTE_METHODS.has(route.method) &&
    typeof route.path === "string" && route.path.startsWith("/") && !route.path.startsWith("//") && route.path.length <= 4096 && !/[\u0000-\u001f]/.test(route.path) &&
    typeof gateway === "object" && gateway !== null &&
    validId(gateway.projectId) && validId(gateway.scopeId) && validId(gateway.runtimeNodeId) && validId(gateway.subject) && validId(gateway.subjectType) && validId(gateway.tenantId) &&
    typeof gateway.generation === "number" && Number.isSafeInteger(gateway.generation) &&
    Array.isArray(gateway.permissions) && gateway.permissions.length <= 64 && gateway.permissions.every((permission) => validId(permission)) &&
    (gateway.accountAccessDigest === undefined ||
      (typeof gateway.accountAccessDigest === "string" && /^[a-f0-9]{64}$/u.test(gateway.accountAccessDigest)));
};

const LEASE_KEY = /^ZELAVIS_LEASE_[A-Z_]+$/;
const LEASE_ENTRIES = 8;
const LEASE_VALUE = 2048;
/** A lease environment fit to be signed: a few `ZELAVIS_LEASE_*` entries of bounded size. */
const validLease = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length <= LEASE_ENTRIES &&
  Object.entries(value).every(([key, entry]) => LEASE_KEY.test(key) && typeof entry === "string" && entry.length <= LEASE_VALUE);
const APP_SHARD_KEY = /^ZELAVIS_APP_SHARDS_[A-Z_]+$/;
const APP_SHARD_ENTRIES = 4;
/** An App shard environment fit to be signed: a few `ZELAVIS_APP_SHARDS_*` entries of bounded size. */
const validAppShards = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length <= APP_SHARD_ENTRIES &&
  Object.entries(value).every(([key, entry]) => APP_SHARD_KEY.test(key) && typeof entry === "string" && entry.length <= LEASE_VALUE);
/** The entries in a fixed order, so the signed payload does not depend on how the caller built the object. */
const sortedLease = (lease: Readonly<Record<string, string>>) => Object.entries(lease).sort(([a], [b]) => (a < b ? -1 : 1));

export interface ProjectDispatchPlacement {
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
  readonly state: "active" | "released";
  readonly leaseExpiresAt: number;
}

const NONCE_NAMESPACE = "agent.project-dispatch-nonce.v1";

/** Persist replay decisions across Agent restarts on a CAS-capable store. */
export function createProjectDispatchNonceConsumer(
  store: ZelavisSystemStore,
  agentId: string,
): {
  consume(nonce: string, expiresAt: number): Promise<boolean>;
  sweepExpired(now?: number): Promise<number>;
} {
  if (!validId(agentId)) throw new TypeError("Invalid Agent id.");
  const keyFor = (nonce: string) => present(Effect.gen(function* () {
    const hash = (yield* integrationValue(crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(`${agentId}\0${nonce}`))));
    return (yield* integrationValue([...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("")));
  }));
  return {
    consume(nonce, expiresAt) {
    return present(Effect.gen(function* () {
      if (!validId(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
      const key = (yield* integrationValue(keyFor(nonce)));
      return ((yield* integrationValue(store.setIfAbsent(NONCE_NAMESPACE, key,
        { agentId, expiresAt })))).created;
    }));
  },
    sweepExpired(now = Date.now()) {
    return present(Effect.gen(function* () {
      if (!Number.isSafeInteger(now)) throw new TypeError("Invalid cleanup time.");
      let removed = 0;
      for (const record of (yield* integrationValue(store.list(NONCE_NAMESPACE)))) {
        const value = record.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const expiry = (value as { readonly expiresAt?: unknown }).expiresAt;
        if (typeof expiry !== "number" || expiry > now) continue;
        if ((yield* integrationValue(store.compareAndDelete(NONCE_NAMESPACE, record.key, record.updatedAt)))) removed += 1;
      }
      return removed;
    }));
  },
  };
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);

function canonical(claims: ProjectDispatchClaims): string {
  return JSON.stringify([
    claims.keyId, claims.agentId, claims.action, claims.projectId,
    claims.nodeId, claims.ownerSession, claims.epoch, claims.issuedAt,
    claims.expiresAt, claims.nonce,
    claims.artifactDigest ?? null,
    claims.lease === undefined ? null : sortedLease(claims.lease),
    claims.route === undefined ? null : claims.route,
    claims.appShards === undefined ? null : sortedLease(claims.appShards),
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Platform signer: one action for one Agent, Project, owner session and epoch. */
export function signProjectDispatchAuthority(
  privateKey: CryptoKey,
  claims: ProjectDispatchClaims,
): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  if (!validId(claims.keyId) || !validId(claims.agentId) ||
      !validId(claims.projectId) || !validId(claims.nodeId) ||
      !validId(claims.ownerSession) || !validId(claims.nonce) ||
      (claims.action !== "prepare" && claims.action !== "start" && claims.action !== "stop" && claims.action !== "standby" && claims.action !== "route") ||
      (claims.lease !== undefined && !validLease(claims.lease)) ||
      (claims.appShards !== undefined && !validAppShards(claims.appShards)) ||
      (claims.route !== undefined && !validRoute(claims.route)) || ((claims.action === "route") !== (claims.route !== undefined)) ||
      (claims.artifactDigest !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(claims.artifactDigest)) ||
      !Number.isSafeInteger(claims.epoch) || claims.epoch < 1 ||
      !Number.isSafeInteger(claims.issuedAt) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > 60_000) {
    throw new TypeError("Project dispatch claims are invalid or unbounded.");
  }
  const payload = canonical(claims);
  const signature = (yield* integrationValue(crypto.subtle.sign("Ed25519", privateKey,
    new TextEncoder().encode(`${CONTEXT}${payload}`))));
  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${base64UrlEncode(new Uint8Array(signature))}`;
}));
  }

/** Destination verifier. The caller must read placement at execution time. */
export function verifyProjectDispatchAuthority(
  trust: ZelavisHostOperationTrustStore,
  token: string,
  options: {
    readonly agentId: string;
    readonly action: "prepare" | "start" | "stop" | "standby" | "route";
    /** The committed placement here. Absent for a standby, which holds none: the lease, not a placement, fences its writes. */
    readonly placement?: ProjectDispatchPlacement;
    /** The Node this Agent is, checked in place of a placement. */
    readonly nodeId?: string;
    readonly now?: number;
    readonly consumeNonce: (nonce: string, expiresAt: number) => boolean | Promise<boolean>;
  },
): Promise<ProjectDispatchClaims | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ProjectDispatchClaims | undefined, IntegrationFailure> {
  if (typeof token !== "string" || token.length > 8_192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;
  let payload: string;
  let signature: Uint8Array<ArrayBuffer>;
  let decoded: unknown;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(token.slice(0, separator)));
    signature = base64UrlDecode(token.slice(separator + 1));
    decoded = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 14) return undefined;
  const [keyId, agentId, action, projectId, nodeId, ownerSession,
    epoch, issuedAt, expiresAt, nonce, artifactDigest, leaseEntries, routeValue, shardEntries] = decoded;
  const route = routeValue === null ? undefined : validRoute(routeValue) ? routeValue : false;
  if (route === false || ((action === "route") !== (route !== undefined))) return undefined;
  const lease = leaseEntries === null ? undefined
    : Array.isArray(leaseEntries) && leaseEntries.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")
      ? Object.fromEntries(leaseEntries as [string, string][]) : false;
  if (lease === false || (lease !== undefined && !validLease(lease))) return undefined;
  const appShards = shardEntries === null ? undefined
    : Array.isArray(shardEntries) && shardEntries.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")
      ? Object.fromEntries(shardEntries as [string, string][]) : false;
  if (appShards === false || (appShards !== undefined && !validAppShards(appShards))) return undefined;
  if (!validId(keyId) || !validId(agentId) || !validId(projectId) ||
      !validId(nodeId) || !validId(ownerSession) || !validId(nonce) ||
      (action !== "prepare" && action !== "start" && action !== "stop" && action !== "standby" && action !== "route") ||
      (artifactDigest !== null &&
        (typeof artifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifactDigest))) ||
      !Number.isSafeInteger(epoch) || epoch < 1 ||
      !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return undefined;
  const now = options.now ?? Date.now();
  const placement = options.placement;
  const placed = placement === undefined
    ? options.nodeId !== undefined && nodeId === options.nodeId
    : Number.isSafeInteger(placement.leaseExpiresAt) &&
      projectId === placement.projectId && nodeId === placement.nodeId &&
      ownerSession === placement.ownerSession && epoch === placement.epoch &&
      placement.state === "active" && placement.leaseExpiresAt > now;
  if (!Number.isSafeInteger(now) || !placed ||
      agentId !== options.agentId || action !== options.action ||
      issuedAt > now + 5_000 || expiresAt <= now ||
      expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) return undefined;
  const publicKey = (yield* integrationValue(resolveTrustedEd25519Key(trust, keyId, now)));
  if (!publicKey || signature.byteLength !== 64 ||
      !((yield* integrationValue(crypto.subtle.verify("Ed25519", publicKey, signature,
        new TextEncoder().encode(`${CONTEXT}${payload}`)))))) return undefined;
  if (!((yield* integrationValue(options.consumeNonce(nonce, expiresAt))))) return undefined;
  return { keyId, agentId, action, projectId, nodeId, ownerSession,
    epoch, issuedAt, expiresAt, nonce,
    ...(artifactDigest === null ? {} : { artifactDigest }),
    ...(lease === undefined ? {} : { lease }),
    ...(appShards === undefined ? {} : { appShards }),
    ...(route === undefined ? {} : { route }) };
}));
  }

/** Authorize one destination operation against the current committed lease. */
export function receiveProjectDispatch<T>(input: {
  readonly trust: ZelavisHostOperationTrustStore;
  readonly token: string;
  readonly agentId: string;
  readonly action: "prepare" | "start" | "stop" | "route";
  readonly projectId: string;
  readonly nodeId: string;
  readonly readPlacement: (projectId: string) => Promise<ProjectDispatchPlacement | undefined>;
  readonly consumeNonce: (nonce: string, expiresAt: number) => boolean | Promise<boolean>;
  readonly execute: (claims: ProjectDispatchClaims) => Promise<T>;
}): Promise<T> {
    return present(Effect.gen(function* (): Effect.fn.Return<T, IntegrationFailure> {
  if (!validId(input.projectId) || !validId(input.nodeId)) {
    throw new TypeError("Invalid destination Project identity.");
  }
  const placement = (yield* integrationValue(input.readPlacement(input.projectId)));
  if (!placement || placement.nodeId !== input.nodeId) {
    throw new Error("Project placement is absent or assigned to another Node.");
  }
  const claims = (yield* integrationValue(verifyProjectDispatchAuthority(input.trust, input.token, {
    agentId: input.agentId,
    action: input.action,
    placement,
    consumeNonce: input.consumeNonce,
  })));
  if (!claims || claims.projectId !== input.projectId) {
    throw new Error("Project dispatch authority is invalid or stale.");
  }
  return (yield* integrationValue(input.execute(claims)));
}));
  }

/**
 * Authorize one operation on a standby: a signed, single-use, destination-bound authority and nothing else. A standby holds
 * no placement (the Project's placement is the writer's); it writes nothing until it holds the writer lease, which is its
 * fence. So there is no committed placement to read here, only the Agent's own identity to check.
 */
export function receiveStandbyDispatch<T>(input: {
  readonly trust: ZelavisHostOperationTrustStore;
  readonly token: string;
  readonly agentId: string;
  readonly action: "prepare" | "standby" | "stop";
  readonly projectId: string;
  readonly nodeId: string;
  readonly consumeNonce: (nonce: string, expiresAt: number) => boolean | Promise<boolean>;
  readonly execute: (claims: ProjectDispatchClaims) => Promise<T>;
}): Promise<T> {
  return present(Effect.gen(function* (): Effect.fn.Return<T, IntegrationFailure> {
    if (!validId(input.projectId) || !validId(input.nodeId)) throw new TypeError("Invalid destination Project identity.");
    const claims = (yield* integrationValue(verifyProjectDispatchAuthority(input.trust, input.token, {
      agentId: input.agentId, action: input.action, nodeId: input.nodeId, consumeNonce: input.consumeNonce,
    })));
    if (!claims || claims.projectId !== input.projectId) throw new Error("Standby dispatch authority is invalid or stale.");
    return (yield* integrationValue(input.execute(claims)));
  }));
}
