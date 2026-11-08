/**
 * A capability for one Project's writer process to ask the Platform for its remote App shards.
 *
 * Like the writer-lease capability, it is an HMAC under a key derived from the installation secret for this purpose
 * alone, and it is worth little if it leaks: it names a Project, the node it runs on and the Project's placement epoch.
 * The channel's routes accept it only while that triple is the Project's current active placement, so a process of an
 * older epoch (a stopped or fenced writer) can no longer obtain access tokens.
 */
import { Effect } from "effect";
import { integration, integrationValue, present, type IntegrationFailure } from "../core/runtime/effect-boundary.js";

const encoder = new TextEncoder();

const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const decode = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try { binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")); } catch { return undefined; }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const key = (secret: string) => present(integration(() => crypto.subtle.importKey(
  "raw", encoder.encode(`${secret}\u0000project-app-shard-capability`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
)));

export interface AppShardCapabilityClaims {
  /** The Project whose shards it reaches. */
  readonly scope: string;
  /** The node the Project's writer runs on. */
  readonly node: string;
  /** The Project's placement epoch. */
  readonly epoch: number;
}

const NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const validEpoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** `payload.signature`, both base64url. */
export function mintAppShardCapability(secret: string, claims: AppShardCapabilityClaims): Promise<string> {
  return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    if (!NAME.test(claims.scope) || !NAME.test(claims.node)) throw new TypeError("An App shard capability names a Project and a node of 1 to 128 plain characters.");
    if (!validEpoch(claims.epoch)) throw new TypeError("An App shard capability names a positive Project epoch.");
    const payload = encoder.encode(JSON.stringify([claims.scope, claims.node, claims.epoch]));
    const signature = yield* integrationValue(crypto.subtle.sign("HMAC", yield* integrationValue(key(secret)), payload));
    return `${encode(payload)}.${encode(new Uint8Array(signature))}`;
  }));
}

/** The claims of an authentic token; `undefined` for anything else, which is simply not authorized. */
export function verifyAppShardCapability(secret: string, token: string): Promise<AppShardCapabilityClaims | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<AppShardCapabilityClaims | undefined, IntegrationFailure> {
    const separator = token.indexOf(".");
    if (separator <= 0 || separator === token.length - 1 || token.length > 1024) return undefined;
    const payload = decode(token.slice(0, separator));
    const signature = decode(token.slice(separator + 1));
    if (!payload || !signature) return undefined;
    if (!(yield* integrationValue(crypto.subtle.verify("HMAC", yield* integrationValue(key(secret)), signature, payload)))) return undefined;
    const decoded = yield* Effect.try({ try: () => JSON.parse(new TextDecoder().decode(payload)) as unknown, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
    if (!Array.isArray(decoded) || decoded.length !== 3) return undefined;
    const [scope, node, epoch] = decoded as unknown[];
    return typeof scope === "string" && typeof node === "string" && NAME.test(scope) && NAME.test(node) && validEpoch(epoch)
      ? { scope, node, epoch } : undefined;
  }));
}
