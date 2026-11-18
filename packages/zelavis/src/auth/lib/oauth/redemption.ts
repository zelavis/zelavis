// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/redemption.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the redemption is an Effect run as one transaction of the bound method (T1-T4); result validators are Effect Schemas (T5); a profile mapping that returns no id is a defect (T8); the ticket payload is decoded through a Schema; a sign-in may answer an MFA arm instead of a session (part 10).
/**
 * The app-side end of an OAuth flow: redeeming the one-time code the callback
 * redirected back with, and the option validation every provider setup runs
 * first.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { AuthCall } from "../../core/context.js";
import type { AuthFailure } from "../../core/errors.js";
import type { RegistrationRefused } from "../../registration/errors.js";
import type { BoundMethod } from "../../core/setup.js";
import { MINUTE, defineRateLimits, invariant } from "../../runtime/index.js";
import { recordSecurityEvent } from "../../security/events.js";
import { sha256Hex } from "../crypto.js";
import { SignInComplete, SignInError, SignInPending } from "../types.js";
import { decryptTicketPayload } from "./crypto.js";
import { type AccountStore, claimTicket, insertAccount } from "./dbHelpers.js";

const auditLimits = defineRateLimits("oauthAudit", {
  failedRedemption: { kind: "token bucket", rate: 10, period: MINUTE },
});

/**
 * Standard OIDC id_token claims. The well-known ones are typed. Any other
 * claim the provider includes is present but untyped (`unknown`).
 *
 * OIDC says `email_verified` is a boolean, and Apple sends the string
 * `"true"` for some accounts, so the type accepts both.
 */
export type OidcClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
};

/**
 * What the callback encrypted into the ticket, and redemption decrypts. Every
 * field is optional because which ones a provider produces depends on how it
 * attests identity:
 *
 * - `claims`: validated id_token claims, for a provider that returns one.
 * - `userInfoResponses`: the responses from the configured userinfo
 *   endpoints, keyed as configured.
 * - `callbackParams`: extra data the provider sent to the callback itself
 *   as a query or form field rather than through a token, already sanitized
 *   by the provider that accepted it. It is browser-relayed and therefore
 *   user-controlled, unlike the other two.
 *
 * At least one of `claims` and `userInfoResponses` is always present: the
 * callback refuses a flow that produced neither.
 */
export type TicketPayload<
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
> = {
  claims?: OidcClaims;
  userInfoResponses?: UserInfo;
  callbackParams?: Record<string, unknown>;
};

const PayloadJson = Schema.fromJsonString(
  Schema.Struct({
    claims: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    userInfoResponses: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    callbackParams: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodePayload = Schema.decodeUnknownExit(PayloadJson);

/** `new URL` without the exception: returns null on unparseable input. */
export function parseUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}

/**
 * Check the origins a runtime will accept as post-login destinations and
 * return them normalized. Called at setup so a mistake fails at start, not on
 * the first sign-in.
 */
export function validateAllowedRedirectOrigins(
  allowedRedirectOrigins: ReadonlyArray<string>,
): string[] {
  return allowedRedirectOrigins.map((allowed) => {
    const url = parseUrl(allowed);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:")
    ) {
      throw new Error(
        `allowedRedirectOrigins entry is not a valid http(s) origin: ` +
          `"${allowed}" (custom schemes like "myapp://" are not supported yet)`,
      );
    }
    // An entry with a path would silently allow the whole origin, which is
    // broader than what the config appears to say. Require bare origins.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error(
        `allowedRedirectOrigins entry must be a bare origin with no path, ` +
          `query, or fragment: "${allowed}" (use "${url.origin}" to allow ` +
          `the whole origin)`,
      );
    }
    return url.origin;
  });
}

export const completeSignInResult = Schema.Union([
  SignInComplete,
  SignInPending,
  // The one-time code did not redeem: unknown, already spent, expired, or
  // paired with a state this browser never held. The server cannot tell those
  // apart and deliberately does not try, so they share one code.
  SignInError(Schema.Struct({ error: Schema.Literal("INVALID_CODE") })),
]);

/**
 * The result of `completeSignIn`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type CompleteSignInResult = typeof completeSignInResult.Type;

/** Claims a ticket and reads what the provider attested; null when the code does not redeem. Runs in the transaction of the caller. */
export const redeemTicket = Effect.fn("auth.lib.oauth.redeemTicket")(function* <Payload extends TicketPayload>(
  tx: Parameters<typeof claimTicket>[0],
  args: { providerName: string; connectionRevision: string; code: string; state: string },
) {
  const ticket = yield* claimTicket(tx, {
    ticketCodeHash: yield* sha256Hex(args.code),
    stateHash: yield* sha256Hex(args.state),
    providerName: args.providerName,
    connectionRevision: args.connectionRevision,
  });
  if (ticket === null) {
    return null;
  }
  // Finding the ticket by hash proves `code` is the value the payload was
  // encrypted under, so decryption only fails on corruption.
  const text = yield* decryptTicketPayload(args.code, ticket.encryptedPayload).pipe(Effect.orDie);
  const payload = decodePayload(text);
  if (!Exit.isSuccess(payload)) {
    return yield* invariant(`The ticket payload of provider "${args.providerName}" does not decode`);
  }
  return payload.value as Payload;
});

/**
 * Build a provider's `completeSignIn`.
 *
 * The client presents the one-time code from the callback redirect together
 * with the state it has held since sign-in started. Both are hashed before
 * they are looked up, and the identity payload is decrypted with a key derived
 * from the raw code. The profile mapping then turns what the provider attested
 * into the account identity. If the provider has an account for the identity,
 * the core signs that user in. Otherwise the core creates a new user, and an
 * account for that user is recorded in the same transaction.
 *
 * Returns the shared sign-in envelope: the session token bundle, or an
 * `INVALID_CODE` error when the code is unknown, already redeemed, expired, or
 * the state doesn't match: all indistinguishable to the caller.
 *
 * It is one transaction, so a failure anywhere (including the runtime
 * rejecting the sign-in from `createUser` / `onSignIn`) rolls back the ticket
 * claim and the account. Only a successful redemption consumes the ticket.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export function buildCompleteSignIn<
  Profile extends { id: string },
  Payload extends TicketPayload = TicketPayload,
>(options: {
  /** The provider's name, for the error message when a mapping returns no id. */
  providerName: string;
  connectionRevision: string;
  isCurrent: (tx: Parameters<typeof claimTicket>[0]) => Effect.Effect<boolean, AuthFailure>;
  /** The method bound to the core, whose transaction the redemption runs in. */
  bound: BoundMethod<Profile>;
  /** The module that authenticates the session, for example `"google"`. The sessions record its name. */
  authenticatedBy: string;
  /** The accounts of this provider. */
  accounts: AccountStore;
  /** Map what the provider attested to the account profile. */
  profile: (payload: Payload) => Profile;
}) {
  return (call: AuthCall, args: { code: string; state: string }) =>
    options.bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* (): Effect.fn.Return<CompleteSignInResult, AuthFailure | RegistrationRefused> {
        if (!(yield* options.isCurrent(tx))) return { status: "error", userError: { error: "INVALID_CODE" } };
        const payload = yield* redeemTicket<Payload>(tx, { providerName: options.providerName, connectionRevision: options.connectionRevision, ...args });
        if (payload === null) {
          const audit = yield* auditLimits.limit(tx, "failedRedemption", { key: tx.request.ip ?? "unknown" });
          if (audit.ok) yield* recordSecurityEvent(tx, { kind: "authentication.failed", detail: { method: `oauth:${options.providerName}`, stage: "redeem" } });
          return { status: "error", userError: { error: "INVALID_CODE" } };
        }

        const profile = options.profile(payload);
        if (typeof profile.id !== "string" || profile.id === "") {
          return yield* invariant(`Profile mapping for provider "${options.providerName}" returned no id`);
        }

        // The same redemption flow serves a first sign-in and a return visit, so
        // look the identity up to pick a path. The lookup and the writes share
        // one transaction, so concurrent first redemptions of one identity
        // create only one user.
        const existingUserId = yield* options.accounts.findUserId(tx, profile.id);
        if (existingUserId !== null) {
          return yield* helpers.completeSignIn(tx, {
            userId: existingUserId,
            profile,
            authenticatedBy: options.authenticatedBy,
            providerRevision: options.connectionRevision,
          });
        }
        const tokens = yield* helpers.completeSignUp(tx, {
          profile,
          authenticatedBy: options.authenticatedBy,
        });
        yield* insertAccount(tx, options.accounts, { providerAccountId: profile.id, userId: tokens.userId });
        return { status: "complete", tokens };
      }),
    );
}
