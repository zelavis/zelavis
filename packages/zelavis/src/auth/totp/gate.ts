/**
 * The second-factor gate (Zelavis-own): what `completeSignIn` asks before it
 * creates a session.
 *
 * An account with an active TOTP gets a `verify` pending sign-in; one without
 * that the MFA policy requires to have one gets an `enroll` pending sign-in.
 * Either way the client receives a random challenge (stored only as its
 * SHA-256 hash) instead of a session, and the session is created by
 * `verify.ts` once the second factor is presented. The pending row remembers
 * the method, the authenticating module and the method's profile (sealed),
 * so the session is the one the first factor would have created.
 */
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import { readProofRevision } from "../accounts/proofs.js";
import { generateRandomToken, sha256Hex } from "../lib/crypto.js";
import type { SignInPending } from "../lib/types.js";
import { type AuthTxBase, invariant } from "../runtime/index.js";
import { hasActiveSecret, seal } from "./helpers.js";
import { policyRequires } from "./policy.js";
import { totpTables } from "./tables.js";

/** How long a client has to present its second factor. */
export const VERIFY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** How long a client has to enroll a required second factor. */
export const ENROLL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes a pending sign-in accepts before it ends. */
export const MAX_CHALLENGE_ATTEMPTS = 5;

type PendingFirstFactor = {
  userId: string;
  method: string;
  component: string;
  profile: unknown;
  methodRevision: number;
  providerRevision?: string | undefined;
};

export interface SecondFactorGate {
  /** Null when the account may have its session now; otherwise the pending answer, with its row written in `tx`. */
  check(tx: AuthTxBase, args: PendingFirstFactor): Effect.Effect<SignInPending | null, TransactionTooLarge>;
}

/** The gate of one runtime; `key` is its TOTP key (`totpKey(masterSecret)`). */
export function createSecondFactorGate({ key }: { key: string }): SecondFactorGate {
  const pend = Effect.fn("auth.totp.gate.pend")(function* (
    tx: AuthTxBase,
    args: PendingFirstFactor,
    kind: "verify" | "enroll",
  ) {
    const proofRevision = yield* readProofRevision(tx, args.userId);
    if (proofRevision === null) return yield* invariant("Cannot issue a second-factor challenge for a missing account.");
    const challenge = generateRandomToken();
    yield* tx.db.insert(totpTables.pendingSignIns, {
      userId: args.userId,
      method: args.method,
      component: args.component,
      sealedProfile: seal(JSON.stringify(args.profile ?? {}), key),
      challengeHash: yield* sha256Hex(challenge),
      proofRevision,
      methodRevision: args.methodRevision,
      providerRevision: args.providerRevision,
      kind,
      attempts: 0,
      expiresAt: tx.now + (kind === "verify" ? VERIFY_CHALLENGE_TTL_MS : ENROLL_CHALLENGE_TTL_MS),
    });
    return challenge;
  });

  return {
    check: Effect.fn("auth.totp.gate.check")(function* (tx, args) {
      if (yield* hasActiveSecret(tx, args.userId)) {
        return { status: "mfa_required", challenge: yield* pend(tx, args, "verify") } satisfies SignInPending;
      }
      if (yield* policyRequires(tx, args.userId)) {
        return { status: "mfa_enrollment_required", challenge: yield* pend(tx, args, "enroll") } satisfies SignInPending;
      }
      return null;
    }),
  };
}
