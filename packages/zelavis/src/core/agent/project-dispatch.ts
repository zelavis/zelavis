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
  readonly action: "prepare" | "start" | "stop";
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly artifactDigest?: string;
}

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
      (claims.action !== "prepare" && claims.action !== "start" && claims.action !== "stop") ||
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
    readonly action: "prepare" | "start" | "stop";
    readonly placement: ProjectDispatchPlacement;
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
  if (!Array.isArray(decoded) || decoded.length !== 11) return undefined;
  const [keyId, agentId, action, projectId, nodeId, ownerSession,
    epoch, issuedAt, expiresAt, nonce, artifactDigest] = decoded;
  if (!validId(keyId) || !validId(agentId) || !validId(projectId) ||
      !validId(nodeId) || !validId(ownerSession) || !validId(nonce) ||
      (action !== "prepare" && action !== "start" && action !== "stop") ||
      (artifactDigest !== null &&
        (typeof artifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifactDigest))) ||
      !Number.isSafeInteger(epoch) || epoch < 1 ||
      !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return undefined;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) ||
      !Number.isSafeInteger(options.placement.leaseExpiresAt) ||
      agentId !== options.agentId || action !== options.action ||
      projectId !== options.placement.projectId || nodeId !== options.placement.nodeId ||
      ownerSession !== options.placement.ownerSession || epoch !== options.placement.epoch ||
      options.placement.state !== "active" || options.placement.leaseExpiresAt <= now ||
      issuedAt > now + 5_000 || expiresAt <= now ||
      expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) return undefined;
  const publicKey = (yield* integrationValue(resolveTrustedEd25519Key(trust, keyId, now)));
  if (!publicKey || signature.byteLength !== 64 ||
      !((yield* integrationValue(crypto.subtle.verify("Ed25519", publicKey, signature,
        new TextEncoder().encode(`${CONTEXT}${payload}`)))))) return undefined;
  if (!((yield* integrationValue(options.consumeNonce(nonce, expiresAt))))) return undefined;
  return { keyId, agentId, action, projectId, nodeId, ownerSession,
    epoch, issuedAt, expiresAt, nonce,
    ...(artifactDigest === null ? {} : { artifactDigest }) };
}));
  }

/** Authorize one destination operation against the current committed lease. */
export function receiveProjectDispatch<T>(input: {
  readonly trust: ZelavisHostOperationTrustStore;
  readonly token: string;
  readonly agentId: string;
  readonly action: "prepare" | "start" | "stop";
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
