// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/oauth/client.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: carry state in tab-local storage and redeem the fragment ticket through HTTP.
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export type AuthBrowserCall<E> = (path: string, body?: object, method?: string) => Effect.Effect<unknown, E>;

const Flow = Schema.Struct({ provider: Schema.String, state: Schema.String, returnTo: Schema.optional(Schema.String) });
const Started = Schema.Struct({ url: Schema.String, state: Schema.String });
class BrowserOAuthError extends Data.TaggedError("BrowserOAuthError")<{ message: string; cause?: unknown }> {}
const invalidFlow = () => new BrowserOAuthError({ message: "This sign-in expired or did not start in this tab. Sign in again." });
const browserFailure = (cause: unknown) => new BrowserOAuthError({ message: "The browser could not complete provider sign-in.", cause });
const storageKey = (callback: string) => `zelavis.auth.oauth:${callback}`;
const decodeFlow = Schema.decodeUnknownOption(Schema.fromJsonString(Flow));

export const startBrowserOAuth = <E>(call: AuthBrowserCall<E>, provider: string, callback: string, returnTo?: string) =>
  Effect.gen(function* () {
    const redirectTo = new URL(callback, location.origin);
    if (redirectTo.origin !== location.origin) return yield* Effect.fail(invalidFlow());
    const started = yield* call(`oauth/${encodeURIComponent(provider)}/start`, { redirectTo: redirectTo.href });
    const result = Schema.decodeUnknownOption(Started)(started);
    if (result._tag === "None") return yield* Effect.fail(invalidFlow());
    yield* Effect.try({
      try: () => {
        const target = new URL(result.value.url);
        if (target.protocol !== "https:" && target.protocol !== "http:") throw invalidFlow();
        sessionStorage.setItem(storageKey(redirectTo.pathname), JSON.stringify({ provider, state: result.value.state, returnTo }));
        location.assign(target.href);
      },
      catch: browserFailure,
    });
  });

export const finishBrowserOAuth = <E>(call: AuthBrowserCall<E>) =>
  Effect.gen(function* () {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get("ticket");
    const refusal = fragment.get("error");
    const pending = yield* Effect.try({
      try: () => {
        const raw = sessionStorage.getItem(storageKey(location.pathname));
        if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
        sessionStorage.removeItem(storageKey(location.pathname));
        return decodeFlow(raw);
      },
      catch: browserFailure,
    });
    if (refusal === "access_denied") return yield* Effect.fail(new BrowserOAuthError({ message: "Sign-in was cancelled by the provider." }));
    if (ticket === null || !/^[A-Za-z0-9_-]{1,256}$/u.test(ticket) || pending._tag === "None") return yield* Effect.fail(invalidFlow());
    const { provider, state, returnTo } = pending.value;
    const result = yield* call(`oauth/${encodeURIComponent(provider)}/redeem`, { ticket, state });
    return { result, returnTo };
  });
