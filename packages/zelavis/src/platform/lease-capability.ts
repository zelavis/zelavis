/**
 * A capability to hold one Project's writer lease, for the one node it names.
 *
 * A Project runtime must reach the Platform's lease authority from wherever it runs, and the credential it carries should
 * be worth as little as possible if it leaks. This one is an HMAC over `(scope, node)` under a key derived from the
 * installation secret for this purpose alone: it names the Project's lease and the node that may hold it, nothing else.
 * The authority's routes check that the lease they are asked to read or write is the token's scope, and that any lease
 * written names the token's node as owner, so a leaked token can neither touch another Project's lease nor make another
 * node the writer. It does not expire, because a Project process runs for as long as it runs and cannot fetch a new one;
 * deleting the Project ends it (the authority refuses a scope that no longer exists), and rotating the installation
 * secret ends them all.
 */
import * as Effect from "effect/Effect";
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
  "raw", encoder.encode(`${secret}\u0000project-writer-lease-capability`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
)));

export interface LeaseCapabilityClaims {
  /** The Project whose lease it opens. */
  readonly scope: string;
  /** The only node it lets own that lease. */
  readonly node: string;
}

const NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const payloadOf = (claims: LeaseCapabilityClaims) => JSON.stringify([claims.scope, claims.node]);

/** `payload.signature`, both base64url. */
export function mintLeaseCapability(secret: string, claims: LeaseCapabilityClaims): Promise<string> {
  return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    if (!NAME.test(claims.scope) || !NAME.test(claims.node)) throw new TypeError("A lease capability names a Project and a node of 1 to 128 plain characters.");
    const payload = encoder.encode(payloadOf(claims));
    const signature = yield* integrationValue(crypto.subtle.sign("HMAC", yield* integrationValue(key(secret)), payload));
    return `${encode(payload)}.${encode(new Uint8Array(signature))}`;
  }));
}

/** The claims of an authentic token; `undefined` for anything else, which is simply not authorized. */
export function verifyLeaseCapability(secret: string, token: string): Promise<LeaseCapabilityClaims | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<LeaseCapabilityClaims | undefined, IntegrationFailure> {
    const separator = token.indexOf(".");
    if (separator <= 0 || separator === token.length - 1 || token.length > 1024) return undefined;
    const payload = decode(token.slice(0, separator));
    const signature = decode(token.slice(separator + 1));
    if (!payload || !signature) return undefined;
    if (!(yield* integrationValue(crypto.subtle.verify("HMAC", yield* integrationValue(key(secret)), signature, payload)))) return undefined;
    const decoded = yield* Effect.try({ try: () => JSON.parse(new TextDecoder().decode(payload)) as unknown, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const [scope, node] = decoded as unknown[];
    return typeof scope === "string" && typeof node === "string" && NAME.test(scope) && NAME.test(node) ? { scope, node } : undefined;
  }));
}
