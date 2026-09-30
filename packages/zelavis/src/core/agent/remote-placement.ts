import { resolveTrustedEd25519Key, type ZelavisHostOperationTrustStore } from "../deployment/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../../system-store.js";

const CONTEXT = "zelavis-agent-placement-v1\n";
const NAMESPACE = "agent.project-placement.v1";
const MAX_LEASE_MS = 15 * 60_000;

export interface RemotePlacementRecord {
  readonly schemaVersion: 1;
  readonly authority: "platform";
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
  readonly revision: number;
  readonly leaseExpiresAt: number;
  readonly state: "active" | "released";
}

export interface RemotePlacementGrant {
  readonly keyId: string;
  readonly agentId: string;
  readonly placement: RemotePlacementRecord;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);

const encode = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const decode = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

function payload(grant: RemotePlacementGrant): string {
  const p = grant.placement;
  return JSON.stringify([
    grant.keyId, grant.agentId, p.schemaVersion, p.authority,
    p.projectId, p.nodeId, p.ownerSession, p.epoch, p.revision,
    p.leaseExpiresAt, p.state, grant.issuedAt, grant.expiresAt,
  ]);
}

/** Platform signs a committed CAS record for one destination Agent. */
export async function signRemotePlacementGrant(
  privateKey: CryptoKey,
  grant: RemotePlacementGrant,
): Promise<string> {
  const p = grant.placement;
  if (!validId(grant.keyId) || !validId(grant.agentId) ||
      p.schemaVersion !== 1 || p.authority !== "platform" ||
      !validId(p.projectId) || !validId(p.nodeId) || !validId(p.ownerSession) ||
      !Number.isSafeInteger(p.epoch) || p.epoch < 1 ||
      !Number.isSafeInteger(p.revision) || p.revision < 1 ||
      !Number.isSafeInteger(p.leaseExpiresAt) || p.state !== "active" ||
      !Number.isSafeInteger(grant.issuedAt) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= grant.issuedAt ||
      grant.expiresAt - grant.issuedAt > 30_000 ||
      p.leaseExpiresAt <= grant.issuedAt ||
      p.leaseExpiresAt - grant.issuedAt > MAX_LEASE_MS) {
    throw new TypeError("Remote placement grant is invalid or unbounded.");
  }
  const body = payload(grant);
  const signature = await crypto.subtle.sign("Ed25519", privateKey,
    new TextEncoder().encode(`${CONTEXT}${body}`));
  return `${encode(new TextEncoder().encode(body))}.${encode(new Uint8Array(signature))}`;
}

export async function verifyRemotePlacementGrant(
  trust: ZelavisHostOperationTrustStore,
  token: string,
  agentId: string,
  nodeId: string,
  now = Date.now(),
): Promise<RemotePlacementGrant | undefined> {
  if (!validId(agentId) || !validId(nodeId) || !Number.isSafeInteger(now) ||
      typeof token !== "string" || token.length > 8_192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const [encoded, signed] = token.split(".");
  let body: string;
  let signature: Uint8Array<ArrayBuffer>;
  let values: unknown;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(decode(encoded!));
    signature = decode(signed!);
    values = JSON.parse(body);
  } catch { return undefined; }
  if (!Array.isArray(values) || values.length !== 13) return undefined;
  const [keyId, audience, schemaVersion, authority, projectId, destination,
    ownerSession, epoch, revision, leaseExpiresAt, state, issuedAt, expiresAt] = values;
  if (!validId(keyId) || audience !== agentId || schemaVersion !== 1 ||
      authority !== "platform" || !validId(projectId) ||
      destination !== nodeId || !validId(ownerSession) ||
      !Number.isSafeInteger(epoch) || epoch < 1 ||
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(leaseExpiresAt) || state !== "active" ||
      !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
      issuedAt > now + 5_000 || expiresAt <= now ||
      expiresAt <= issuedAt || expiresAt - issuedAt > 30_000 ||
      leaseExpiresAt <= now || leaseExpiresAt - issuedAt > MAX_LEASE_MS ||
      signature.byteLength !== 64) return undefined;
  const key = await resolveTrustedEd25519Key(trust, keyId, now);
  if (!key || !(await crypto.subtle.verify("Ed25519", key, signature,
    new TextEncoder().encode(`${CONTEXT}${body}`)))) return undefined;
  return {
    keyId, agentId: audience,
    placement: { schemaVersion, authority, projectId, nodeId: destination,
      ownerSession, epoch, revision, leaseExpiresAt, state },
    issuedAt, expiresAt,
  };
}

/** Local durable high-water state; never takes a newer owner over an old process. */
export function createRemotePlacementLeaseStore(options: {
  readonly store: ZelavisSystemStore;
  readonly trust: ZelavisHostOperationTrustStore;
  readonly agentId: string;
  readonly nodeId: string;
  readonly fencePrevious: (placement: RemotePlacementRecord) => Promise<boolean>;
}) {
  const read = async (projectId: string): Promise<RemotePlacementRecord | undefined> => {
    if (!validId(projectId)) return undefined;
    const record = await options.store.get(NAMESPACE, projectId);
    if (!record || !record.value || typeof record.value !== "object" ||
        Array.isArray(record.value)) return undefined;
    const value = record.value as unknown as RemotePlacementRecord;
    if (value.schemaVersion !== 1 || value.authority !== "platform" ||
        value.projectId !== projectId || !validId(value.nodeId) ||
        !validId(value.ownerSession) || !Number.isSafeInteger(value.epoch) ||
        !Number.isSafeInteger(value.revision) ||
        !Number.isSafeInteger(value.leaseExpiresAt) ||
        (value.state !== "active" && value.state !== "released")) {
      throw new Error("Malformed remote placement high-water record.");
    }
    return value;
  };
  return {
    async read(projectId: string) {
      const placement = await read(projectId);
      return placement ? { ...placement, authorityNow: Date.now() } : undefined;
    },
    async accept(token: string): Promise<RemotePlacementRecord> {
      const grant = await verifyRemotePlacementGrant(options.trust, token,
        options.agentId, options.nodeId);
      if (!grant) throw new Error("Remote placement grant is invalid or expired.");
      const next = grant.placement;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const observed = await options.store.get(NAMESPACE, next.projectId);
        const previous = await read(next.projectId);
        if (previous) {
          if (next.epoch < previous.epoch ||
              (next.epoch === previous.epoch && next.revision < previous.revision)) {
            throw new Error("Remote placement grant is stale.");
          }
          if (next.epoch === previous.epoch) {
            if (next.ownerSession !== previous.ownerSession || next.nodeId !== previous.nodeId ||
                next.leaseExpiresAt < previous.leaseExpiresAt ||
                previous.state !== "active") {
              throw new Error("Remote placement grant conflicts with current authority.");
            }
            if (next.revision === previous.revision) {
              if (next.leaseExpiresAt !== previous.leaseExpiresAt) {
                throw new Error("Remote placement revision was reused.");
              }
              return previous;
            }
          } else if (previous.state === "active" &&
              !(await options.fencePrevious(previous))) {
            throw new Error("The prior remote placement has not been fenced.");
          }
        }
        const value = next as unknown as ZelavisSystemStoreValue;
        const written = observed
          ? await options.store.compareAndSet(NAMESPACE, next.projectId,
              observed.updatedAt, value, observed.value)
          : (await options.store.setIfAbsent(NAMESPACE, next.projectId, value)).created;
        if (written) return next;
      }
      throw new Error("Remote placement CAS remained contended.");
    },
    async release(placement: Pick<RemotePlacementRecord,
      "projectId" | "nodeId" | "ownerSession" | "epoch">): Promise<boolean> {
      const observed = await options.store.get(NAMESPACE, placement.projectId);
      const current = await read(placement.projectId);
      if (!observed || !current || current.nodeId !== placement.nodeId ||
          current.ownerSession !== placement.ownerSession || current.epoch !== placement.epoch) return false;
      if (current.state === "released") return true;
      return Boolean(await options.store.compareAndSet(NAMESPACE, placement.projectId,
        observed.updatedAt, { ...current, state: "released" } as ZelavisSystemStoreValue,
        observed.value));
    },
  };
}
