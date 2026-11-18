// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/browser/sessionManager.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Effect manages the storage and lock, and expiry is reported by HTTP.
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { TokenBundle } from "../auth/lib/types.js";
import type { ZelavisAuthClient, ZelavisAuthRefreshResult, ZelavisAuthTokens } from "./auth-client.js";

export interface AuthTokenStorage {
  getItem(key: string): string | null | undefined | PromiseLike<string | null | undefined>;
  setItem(key: string, value: string): void | PromiseLike<void>;
  removeItem(key: string): void | PromiseLike<void>;
}

export interface BrowserAuthSessionOptions {
  /** Opt in to persistent bearer storage. Same-origin dashboards use HttpOnly cookies instead. */
  readonly storage?: AuthTokenStorage;
  /** The API URL is included when the session is attached to a Zelavis client. */
  readonly namespace?: string;
}

class AuthSessionError extends Data.TaggedError("AuthSessionError")<{ message: string; cause?: unknown }> {}

const localLock = Semaphore.makeUnsafe(1);

/** There is no cross-tab lock in environments without Web Locks. */
export function withAuthLock<A, E>(key: string, work: Effect.Effect<A, E>): Effect.Effect<A, E | AuthSessionError> {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return localLock.withPermit(work);
  return Effect.tryPromise({
    try: signal => locks.request(key, { signal }, () => Effect.runPromise(Effect.result(work))),
    catch: cause => new AuthSessionError({ message: "Could not acquire the browser session lock.", cause }),
  }).pipe(Effect.flatMap(result => result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)));
}

export const isAuthTokenBundle = Schema.is(TokenBundle);
const readTokens = Schema.decodeUnknownOption(Schema.fromJsonString(TokenBundle));

export function createBrowserAuthSession(apiUrl: string, api: ZelavisAuthClient["session"], options: BrowserAuthSessionOptions) {
  const key = `zelavis.auth.bearer:${apiUrl}:${options.namespace ?? ""}`;
  const storage = options.storage;
  let memory: ZelavisAuthTokens | undefined;
  const load = Effect.fn("sdk.auth.load")(function* () {
    if (storage === undefined) return memory;
    const raw = yield* Effect.tryPromise({ try: () => Promise.resolve(storage.getItem(key)), catch: cause => new AuthSessionError({ message: "Could not read or change the bearer session.", cause }) });
    if (raw == null) return undefined;
    const decoded = readTokens(raw);
    if (decoded._tag === "None") return yield* Effect.fail(new AuthSessionError({ message: "The stored Zelavis session is invalid." }));
    return decoded.value;
  });
  const save = Effect.fn("sdk.auth.save")(function* (tokens: ZelavisAuthTokens | undefined) {
    if (storage === undefined) {
      memory = tokens;
      return;
    }
    yield* Effect.tryPromise({
      try: () => Promise.resolve(tokens === undefined ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(tokens))),
      catch: cause => new AuthSessionError({ message: "Could not read or change the bearer session.", cause }),
    });
  });
  const rotate = Effect.fn("sdk.auth.rotate")(function* (current: ZelavisAuthTokens): Effect.fn.Return<ZelavisAuthRefreshResult, AuthSessionError> {
    // The server may commit even if the connection drops. Repeating a spent token revokes its session.
    const result = yield* Effect.tryPromise({ try: () => api.refresh({ refreshToken: current.refreshToken }), catch: cause => new AuthSessionError({ message: "Could not read or change the bearer session.", cause }) });
    if (result.kind === "noSession") {
      yield* save(undefined);
      return result;
    }
    if (result.kind !== "rotated" || !isAuthTokenBundle(result.tokens)) {
      return yield* Effect.fail(new AuthSessionError({ message: "The server did not return a valid bearer session." }));
    }
    yield* save(result.tokens);
    return result;
  });
  return {
    load,
    accept: (tokens: ZelavisAuthTokens) => withAuthLock(key, save(tokens)),
    refresh: (expired: string) => withAuthLock(key, Effect.gen(function* () {
      const current = yield* load();
      if (current === undefined) return false;
      if (current.accessToken !== expired) return true;
      return (yield* rotate(current)).kind === "rotated";
    })),
    refreshCurrent: () => withAuthLock(key, Effect.gen(function* () {
      const current = yield* load();
      return current === undefined ? { kind: "noSession" } as const : yield* rotate(current);
    })),
    signOut: () => withAuthLock(key, Effect.gen(function* () {
      const current = yield* load();
      if (current === undefined) return;
      yield* Effect.tryPromise({ try: () => api.signOut({ refreshToken: current.refreshToken }), catch: cause => new AuthSessionError({ message: "Could not read or change the bearer session.", cause }) });
      yield* save(undefined);
    })),
  };
}
