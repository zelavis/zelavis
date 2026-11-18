/**
 * The context every ported core mutation and query receives.
 *
 * Upstream's handlers get Convex's `ctx`: `ctx.db`, `ctx.auth.signJwt`,
 * `ctx.auth.getUserIdentity()` and `ctx.meta.getRequestMetadata()`. Here the
 * transaction (`AuthTxBase`) already has the database, the time and the
 * request's address; `AuthTx` adds the signing keys and the caller.
 */
import * as Effect from "effect/Effect";
import type { TransactionConflict, TransactionTooLarge } from "../../db/errors.js";
import type { AuthRequest, AuthRuntime, AuthTxBase } from "../runtime/index.js";

/** The session the caller's access token named, already known to be live when the authenticator resolved it. */
export interface AuthCaller {
  readonly sessionId: string;
  readonly userId: string;
}

/** What a call knows of its origin: the trusted client address and, when signed in, the caller. */
export interface AuthCall extends AuthRequest {
  readonly caller?: AuthCaller | undefined;
}

/** What a mutation signs access tokens with (`ctx.auth.signJwt`). */
export interface AuthKeys {
  /** Signs an access token whose `sub` is `claims.sub`; the issuer, audience and times are the runtime's. */
  readonly sign: (args: { readonly claims: { readonly sub: string }; readonly expiresInSeconds: number }) => Effect.Effect<string>;
}

export type AuthTx = AuthTxBase & {
  readonly keys: AuthKeys;
  /** The roles a public sign-up's account starts with: `customer` on the Platform, `user` in an App. */
  readonly signUpRoles: ReadonlyArray<string>;
  /** `ctx.auth.getUserIdentity()`: who the request's access token names, or undefined. */
  readonly caller: AuthCaller | undefined;
};

export interface CoreRuntime {
  mutation<A, E>(call: AuthCall, body: (tx: AuthTx) => Effect.Effect<A, E>): Effect.Effect<A, E | TransactionConflict | TransactionTooLarge>;
  query<A, E>(call: AuthCall, body: (tx: AuthTx) => Effect.Effect<A, E>): Effect.Effect<A, E>;
}

/** The roles a public sign-up starts with in a runtime of `role`; access is changed by administrators. */
export const signUpRolesFor = (role: "platform" | "project"): ReadonlyArray<string> => (role === "platform" ? ["customer"] : ["user"]);

/** The module runtime with the signing keys, the sign-up roles and the caller added to every transaction. */
export const createCoreRuntime = (runtime: AuthRuntime, keys: AuthKeys, signUpRoles: ReadonlyArray<string>): CoreRuntime => {
  const withContext = (call: AuthCall) => (tx: AuthTxBase): AuthTx => ({ ...tx, keys, signUpRoles, caller: call.caller });
  return {
    mutation: (call, body) => runtime.mutation(call, (tx) => body(withContext(call)(tx))),
    query: (call, body) => runtime.query(call, (tx) => body(withContext(call)(tx))),
  };
};
