import * as Effect from "effect/Effect";
import type { AuthTx } from "../../core/context.js";
import { getAuthUserId } from "../../core/userId.js";
import { handleForUser, passkeyByCredential } from "../../passkey/helpers.js";
import type { RelyingParty } from "../../passkey/registration.js";
import { passkeyTables, type ChallengeRow, type PasskeyRow } from "../../passkey/tables.js";
import type { WireAuthenticationResponse } from "../../passkey/validation.js";

type Purpose = ChallengeRow["purpose"];
export const reject = <const Code extends string>(error: Code) => ({ success: false, userError: { error } }) as const;
export const expired = reject("CHALLENGE_EXPIRED");
export const protocolError = reject("PROTOCOL_ERROR");

/** Read the challenge under the current RP revision and, for management, the same live session. */
export const readChallenge = Effect.fn("auth.passkey.readChallenge")(function* (
  tx: AuthTx, settings: RelyingParty, flowId: string, purpose: Purpose,
) {
  const challenge = yield* tx.db.get(passkeyTables.challenges, flowId);
  if (challenge === null || challenge.expiresAt <= tx.now || challenge.revision !== settings.revision) return expired;
  if (challenge.purpose !== purpose) return protocolError;
  if (challenge.sessionId !== undefined) {
    const userId = yield* getAuthUserId(tx);
    if (userId === null) return reject("NOT_LOGGED_IN");
    if (tx.caller?.sessionId !== challenge.sessionId || userId !== challenge.userId) return protocolError;
  }
  return { success: true, challenge } as const;
});

export const readAssertion = Effect.fn("auth.passkey.readAssertion")(function* (
  tx: AuthTx, settings: RelyingParty, flowId: string, purpose: Purpose, response: WireAuthenticationResponse,
) {
  const pending = yield* readChallenge(tx, settings, flowId, purpose);
  if (!pending.success) return pending;
  const passkey = yield* passkeyByCredential(tx, settings.rpId, response.rawId);
  if (passkey === null) return reject("UNKNOWN_CREDENTIAL");
  const { challenge } = pending;
  if (challenge.userId !== undefined && passkey.userId !== challenge.userId) return protocolError;
  const handle = yield* handleForUser(tx, passkey.userId, settings.rpId);
  if (handle === null) return protocolError;
  const reported = response.response.userHandle;
  if (reported === undefined ? challenge.userId === undefined : reported !== handle.handle) return protocolError;
  return { success: true, challenge, passkey, handle } as const;
});

/** Match the immutable credential fields between verification and commit. Rename and counter updates are independent. */
export const sameCredential = (before: PasskeyRow, after: PasskeyRow) =>
  before._id === after._id && before.userId === after.userId && before.rpId === after.rpId
    && before.credentialId === after.credentialId && before.publicKey === after.publicKey;

export const sameChallenge = (before: ChallengeRow, after: ChallengeRow) =>
  before._id === after._id && before.challenge === after.challenge && before.revision === after.revision
    && before.purpose === after.purpose && before.expiresAt === after.expiresAt && before.username === after.username
    && before.userId === after.userId && before.sessionId === after.sessionId && before.handle === after.handle
    && before.removeId === after.removeId && before.verifiedPasskeyId === after.verifiedPasskeyId;
