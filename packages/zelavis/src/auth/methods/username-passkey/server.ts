// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/username-passkey/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries; the method is bound without the second-factor gate; a runtime closed to registration starts no sign-up ceremony.
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../../db/errors.js";
import { accountsModule } from "../../accounts/accounts.js";
import type { AuthCall, AuthTx } from "../../core/context.js";
import type { AuthCore } from "../../core/setup.js";
import { getAuthUserId } from "../../core/userId.js";
import { generateRandomToken } from "../../lib/crypto.js";
import type { CreateUserFn, OnSignInFn } from "../../lib/types.js";
import { verifyAssertion } from "../../passkey/authentication.js";
import { credentialDescriptors, handleForUser, insertChallenge, MAX_PASSKEYS_PER_USER, passkeyByCredential, passkeysForUser } from "../../passkey/helpers.js";
import { type RelyingParty, verifyAttestation } from "../../passkey/registration.js";
import { type ChallengeRow, passkeyTables } from "../../passkey/tables.js";
import { passkeyNameIsValid, type WireAuthenticationResponse, type WireRegistrationResponse } from "../../passkey/validation.js";
import { defineRateLimits, invariant, MINUTE } from "../../runtime/index.js";
import { recordSecurityEvent } from "../../security/events.js";
import { getUserIdByUsername, getUsername, setUsername } from "../../username/public.js";
import { validateUsernameFormat } from "../../username/validation.js";
import { fromBase64URL } from "./base64url.js";
import { expired, protocolError, readAssertion, readChallenge, reject, sameChallenge, sameCredential } from "./ceremonies.js";
import { buildAuthenticationOptions, buildRegistrationOptions } from "./options.js";
import { ADD_PASSKEY_PURPOSE, REMOVE_PASSKEY_PURPOSE, SIGN_IN_PURPOSE } from "./purposes.js";

const METHOD = "usernamePasskey";
const COMPONENT = "passkey";
const limits = defineRateLimits(COMPONENT, {
  start: { kind: "token bucket", rate: 30, period: MINUTE },
  verify: { kind: "token bucket", rate: 30, period: MINUTE },
});

const limit = Effect.fn("auth.passkey.limit")(function* (tx: AuthTx, operation: "start" | "verify") {
  const result = yield* limits.limit(tx, operation, { key: tx.request.ip ?? "unknown" });
  return result.ok ? null : { success: false, userError: { error: "RATE_LIMITED", retryAfterMs: result.retryAfter } } as const;
});

type Flow = Pick<ChallengeRow, "username" | "userId" | "sessionId" | "handle" | "removeId" | "verifiedPasskeyId">;
type Assertion = { flowId: string; response: WireAuthenticationResponse };
type Registration = { flowId: string; response: WireRegistrationResponse };
type Profile = { username: string };

function newRegistration(tx: AuthTx, settings: RelyingParty, purpose: "register" | "add-register", fields: Flow & { username: string; handle: string }, excludeCredentials: ReturnType<typeof credentialDescriptors>) {
  return insertChallenge(tx, { ...fields, purpose, revision: settings.revision }).pipe(Effect.map(({ flowId, challenge }) => ({
    success: true, flowId, options: buildRegistrationOptions({
      ...settings, challenge, userHandle: fromBase64URL(fields.handle), userName: fields.username,
      userDisplayName: fields.username, excludeCredentials,
    }),
  }) as const));
}

function newAssertion(tx: AuthTx, settings: RelyingParty, purpose: typeof SIGN_IN_PURPOSE | typeof ADD_PASSKEY_PURPOSE | typeof REMOVE_PASSKEY_PURPOSE, fields: Flow, allowCredentials: ReturnType<typeof credentialDescriptors>) {
  return insertChallenge(tx, { ...fields, purpose, revision: settings.revision }).pipe(Effect.map(({ flowId, challenge }) => ({
    success: true, flowId, options: buildAuthenticationOptions({ rpId: settings.rpId, challenge, allowCredentials }),
  }) as const));
}

export function setupUsernamePasskey(core: AuthCore, options: {
  readonly settings: (tx: AuthTx) => Effect.Effect<RelyingParty, TransactionTooLarge>;
  readonly createUser?: CreateUserFn<Profile>;
  readonly onSignIn?: OnSignInFn<Profile>;
}) {
  const bound = core.bindMethod<Profile>({
    name: METHOD,
    // A passkey is a phishing-resistant factor of its own: its sign-in is not
    // followed by a TOTP challenge (Zelavis, part 10).
    secondFactor: false,
    createUser: options.createUser ?? accountsModule.createUser,
    onSignIn: options.onSignIn ?? accountsModule.onSignIn,
  });

  const startSignUp = (call: AuthCall, username: string) => bound.mutation(call, (tx, helpers) => Effect.gen(function* () {
    // Zelavis: a runtime that admits no sign-ups starts no ceremony (part 11).
    yield* helpers.assertSignUpOpen(tx);
    const userError = validateUsernameFormat(username);
    if (userError !== null) return { success: false, userError } as const;
    const limited = yield* limit(tx, "start");
    if (limited !== null) return limited;
    if ((yield* getUserIdByUsername(tx, { username })) !== null) return reject("USERNAME_TAKEN");
    const settings = yield* options.settings(tx);
    return yield* newRegistration(tx, settings, "register", { username, handle: generateRandomToken() }, []);
  }));

  const startSignIn = (call: AuthCall, username?: string) => bound.mutation(call, (tx) => Effect.gen(function* () {
    const limited = yield* limit(tx, "start");
    if (limited !== null) return limited;
    const settings = yield* options.settings(tx);
    if (username === undefined) return yield* newAssertion(tx, settings, SIGN_IN_PURPOSE, {}, []);
    const userError = validateUsernameFormat(username);
    if (userError !== null) return { success: false, userError } as const;
    const userId = yield* getUserIdByUsername(tx, { username });
    if (userId === null) return reject("USER_NOT_FOUND");
    const passkeys = yield* passkeysForUser(tx, userId, settings.rpId);
    if (passkeys.length === 0) return reject("UNKNOWN_CREDENTIAL");
    return yield* newAssertion(tx, settings, SIGN_IN_PURPOSE, { username, userId }, credentialDescriptors(passkeys));
  }));

  // Capture the challenge before SimpleWebAuthn runs. The final mutation compares it again.
  const prepareRegistration = Effect.fn("auth.passkey.prepareRegistration")(function* (
    call: AuthCall, input: Registration, purpose: "register" | "add-register",
  ) {
    const prepared = yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const limited = yield* limit(tx, "verify");
      if (limited !== null) return limited;
      const settings = yield* options.settings(tx);
      const pending = yield* readChallenge(tx, settings, input.flowId, purpose);
      return pending.success ? { ...pending, settings } as const : pending;
    }));
    if (!prepared.success) return prepared;
    const credential = yield* verifyAttestation(prepared.settings, prepared.challenge, input.response);
    return credential === null ? protocolError : { ...prepared, credential } as const;
  });

  const finishSignUp = Effect.fn("auth.passkey.finishSignUp")(function* (call: AuthCall, input: Registration) {
    const prepared = yield* prepareRegistration(call, input, "register");
    if (!prepared.success) return prepared;
    return yield* bound.mutation(call, (tx, helpers) => Effect.gen(function* () {
      const settings = yield* options.settings(tx);
      const pending = yield* readChallenge(tx, settings, input.flowId, "register");
      if (!pending.success) return pending;
      const { challenge } = pending;
      if (!sameChallenge(prepared.challenge, challenge)) return expired;
      const { username, handle } = challenge;
      if (username === undefined || handle === undefined) return yield* invariant("Passkey sign-up challenge lacks its username or handle");
      if ((yield* getUserIdByUsername(tx, { username })) !== null) return reject("USERNAME_TAKEN");
      if ((yield* passkeyByCredential(tx, settings.rpId, prepared.credential.credentialId)) !== null) return reject("CREDENTIAL_ALREADY_REGISTERED");
      const existingHandle = yield* tx.db.query(passkeyTables.handles)
        .withIndex("by_rp_handle", (q) => q.eq("rpId", settings.rpId).eq("handle", handle)).unique();
      if (existingHandle !== null) return protocolError;
      const tokens = yield* helpers.completeSignUp(tx, { profile: { username }, authenticatedBy: COMPONENT });
      const saved = yield* setUsername(tx, { userId: tokens.userId, username });
      if (!saved.success) return yield* invariant("The passkey sign-up username changed within its transaction");
      yield* tx.db.insert(passkeyTables.handles, { userId: tokens.userId, rpId: settings.rpId, handle });
      yield* tx.db.insert(passkeyTables.passkeys, { userId: tokens.userId, rpId: settings.rpId, ...prepared.credential });
      yield* tx.db.delete(passkeyTables.challenges, challenge._id);
      return { status: "complete", tokens, username } as const;
    }));
  });

  const prepareAssertion = Effect.fn("auth.passkey.prepareAssertion")(function* (
    call: AuthCall, input: Assertion, purpose: typeof SIGN_IN_PURPOSE | typeof ADD_PASSKEY_PURPOSE | typeof REMOVE_PASSKEY_PURPOSE,
  ) {
    const prepared = yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const limited = yield* limit(tx, "verify");
      if (limited !== null) return limited;
      const settings = yield* options.settings(tx);
      const pending = yield* readAssertion(tx, settings, input.flowId, purpose, input.response);
      if (!pending.success && purpose === SIGN_IN_PURPOSE) {
        yield* recordSecurityEvent(tx, { kind: "authentication.failed", detail: { method: METHOD } });
      }
      return pending.success ? { ...pending, settings } as const : pending;
    }));
    if (!prepared.success) return prepared;
    const counter = yield* verifyAssertion(prepared.settings, prepared.challenge, prepared.passkey, input.response);
    if (counter === null && purpose === SIGN_IN_PURPOSE) {
      yield* bound.mutation(call, (tx) => recordSecurityEvent(tx, {
        kind: "authentication.failed", accountId: prepared.passkey.userId, detail: { method: METHOD },
      }));
    }
    return counter === null ? protocolError : { ...prepared, counter } as const;
  });

  type VerifiedAssertion = Extract<Effect.Success<ReturnType<typeof prepareAssertion>>, { success: true }>;
  const currentAssertion = Effect.fn("auth.passkey.currentAssertion")(function* (
    tx: AuthTx, input: Assertion, prepared: VerifiedAssertion,
  ) {
    const settings = yield* options.settings(tx);
    const purpose = prepared.challenge.purpose;
    const current = yield* readAssertion(tx, settings, input.flowId, purpose, input.response);
    if (!current.success) return current;
    if (!sameChallenge(prepared.challenge, current.challenge)) return expired;
    if (!sameCredential(prepared.passkey, current.passkey)
      || prepared.handle._id !== current.handle._id || prepared.handle.handle !== current.handle.handle) return protocolError;
    return { ...current, settings } as const;
  });

  function consumeAssertion(tx: AuthTx, current: Pick<VerifiedAssertion, "passkey" | "challenge">, counter: number) {
    return Effect.gen(function* () {
      yield* tx.db.patch(passkeyTables.passkeys, current.passkey._id, { counter });
      yield* tx.db.delete(passkeyTables.challenges, current.challenge._id);
    });
  }

  const finishSignIn = Effect.fn("auth.passkey.finishSignIn")(function* (call: AuthCall, input: Assertion) {
    const prepared = yield* prepareAssertion(call, input, SIGN_IN_PURPOSE);
    if (!prepared.success) return prepared;
    return yield* bound.mutation(call, (tx, helpers) => Effect.gen(function* () {
      const current = yield* currentAssertion(tx, input, prepared);
      if (!current.success) return current;
      const { userId } = current.passkey;
      if ((yield* accountsModule.get(tx, userId)) === null) return protocolError;
      if (current.challenge.username !== undefined && (yield* getUserIdByUsername(tx, { username: current.challenge.username })) !== userId) return protocolError;
      const username = yield* getUsername(tx, { userId });
      if (username === null) return protocolError;
      yield* consumeAssertion(tx, current, prepared.counter);
      const outcome = yield* helpers.completeSignIn(tx, { userId, profile: { username }, authenticatedBy: COMPONENT });
      // Bound with `secondFactor: false`, so the gate never stops it.
      if (outcome.status !== "complete") return yield* invariant("A passkey sign-in was stopped by the second-factor gate");
      return { status: "complete", tokens: outcome.tokens, username } as const;
    }));
  });

  const startManagement = (call: AuthCall, purpose: typeof ADD_PASSKEY_PURPOSE | typeof REMOVE_PASSKEY_PURPOSE, removeId?: string) =>
    bound.mutation(call, (tx) => Effect.gen(function* () {
      const userId = yield* getAuthUserId(tx);
      if (userId === null || tx.caller === undefined) return reject("NOT_LOGGED_IN");
      const limited = yield* limit(tx, "start");
      if (limited !== null) return limited;
      const settings = yield* options.settings(tx);
      const passkeys = yield* passkeysForUser(tx, userId, settings.rpId);
      if (purpose === ADD_PASSKEY_PURPOSE) {
        if (passkeys.length === 0) return reject("UNKNOWN_CREDENTIAL");
        if (passkeys.length >= MAX_PASSKEYS_PER_USER) return reject("TOO_MANY_PASSKEYS");
        return yield* newAssertion(tx, settings, ADD_PASSKEY_PURPOSE, { userId, sessionId: tx.caller.sessionId }, credentialDescriptors(passkeys));
      }
      if (removeId === undefined || !passkeys.some((row) => row._id === removeId)) return reject("PASSKEY_NOT_FOUND");
      if (passkeys.length < 2) return reject("LAST_PASSKEY");
      return yield* newAssertion(tx, settings, REMOVE_PASSKEY_PURPOSE, { userId, sessionId: tx.caller.sessionId, removeId },
        credentialDescriptors(passkeys.filter((row) => row._id !== removeId)));
    }));

  const verifyAdd = Effect.fn("auth.passkey.verifyAdd")(function* (call: AuthCall, input: Assertion) {
    const prepared = yield* prepareAssertion(call, input, ADD_PASSKEY_PURPOSE);
    if (!prepared.success) return prepared;
    return yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const current = yield* currentAssertion(tx, input, prepared);
      if (!current.success) return current;
      const { userId } = current.passkey;
      const passkeys = yield* passkeysForUser(tx, userId, current.settings.rpId);
      if (passkeys.length >= MAX_PASSKEYS_PER_USER) return reject("TOO_MANY_PASSKEYS");
      const username = yield* getUsername(tx, { userId });
      if (username === null || tx.caller === undefined) return protocolError;
      yield* consumeAssertion(tx, current, prepared.counter);
      return yield* newRegistration(tx, current.settings, "add-register", {
        username, userId, sessionId: tx.caller.sessionId, handle: current.handle.handle, verifiedPasskeyId: current.passkey._id,
      }, credentialDescriptors(passkeys));
    }));
  });

  const finishAdd = Effect.fn("auth.passkey.finishAdd")(function* (call: AuthCall, input: Registration) {
    const prepared = yield* prepareRegistration(call, input, "add-register");
    if (!prepared.success) return prepared;
    return yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const settings = yield* options.settings(tx);
      const pending = yield* readChallenge(tx, settings, input.flowId, "add-register");
      if (!pending.success) return pending;
      const { challenge } = pending;
      if (!sameChallenge(prepared.challenge, challenge)) return expired;
      const { userId, verifiedPasskeyId } = challenge;
      if (userId === undefined || verifiedPasskeyId === undefined) return protocolError;
      const passkeys = yield* passkeysForUser(tx, userId, settings.rpId);
      if (!passkeys.some((row) => row._id === verifiedPasskeyId)) return protocolError;
      if (passkeys.length >= MAX_PASSKEYS_PER_USER) return reject("TOO_MANY_PASSKEYS");
      const handle = yield* handleForUser(tx, userId, settings.rpId);
      if (handle === null || handle.handle !== challenge.handle) return protocolError;
      if ((yield* passkeyByCredential(tx, settings.rpId, prepared.credential.credentialId)) !== null) return reject("CREDENTIAL_ALREADY_REGISTERED");
      const passkeyId = yield* tx.db.insert(passkeyTables.passkeys, { userId, rpId: settings.rpId, ...prepared.credential });
      yield* tx.db.delete(passkeyTables.challenges, challenge._id);
      return { success: true, passkeyId } as const;
    }));
  });

  const finishRemove = Effect.fn("auth.passkey.finishRemove")(function* (call: AuthCall, input: Assertion & { passkeyId: string }) {
    const prepared = yield* prepareAssertion(call, input, REMOVE_PASSKEY_PURPOSE);
    if (!prepared.success) return prepared;
    return yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const current = yield* currentAssertion(tx, input, prepared);
      if (!current.success) return current;
      if (current.challenge.removeId !== input.passkeyId || current.passkey._id === input.passkeyId) return protocolError;
      const passkeys = yield* passkeysForUser(tx, current.passkey.userId, current.settings.rpId);
      if (!passkeys.some((row) => row._id === input.passkeyId)) return reject("PASSKEY_NOT_FOUND");
      if (passkeys.length < 2) return reject("LAST_PASSKEY");
      yield* consumeAssertion(tx, current, prepared.counter);
      yield* tx.db.delete(passkeyTables.passkeys, input.passkeyId);
      return { success: true } as const;
    }));
  });

  const list = (call: AuthCall) => bound.query(call, (tx) => Effect.gen(function* () {
    const userId = yield* getAuthUserId(tx);
    if (userId === null) return reject("NOT_LOGGED_IN");
    const settings = yield* options.settings(tx);
    const passkeys = yield* passkeysForUser(tx, userId, settings.rpId);
    return { success: true, passkeys: passkeys.map(({ _id, _creationTime, credentialId, name, transports }) =>
      ({ passkeyId: _id, createdAt: _creationTime, credentialId, name, transports })) } as const;
  }));

  const rename = (call: AuthCall, passkeyId: string, name: string) => bound.mutation(call, (tx) => Effect.gen(function* () {
    const userId = yield* getAuthUserId(tx);
    if (userId === null) return reject("NOT_LOGGED_IN");
    const settings = yield* options.settings(tx);
    if (!passkeyNameIsValid(name)) return reject("INVALID_PASSKEY_NAME");
    const passkey = yield* tx.db.get(passkeyTables.passkeys, passkeyId);
    if (passkey === null || passkey.userId !== userId || passkey.rpId !== settings.rpId) return reject("PASSKEY_NOT_FOUND");
    yield* tx.db.patch(passkeyTables.passkeys, passkeyId, { name });
    return { success: true } as const;
  }));

  return {
    startSignUp, finishSignUp, startSignIn, finishSignIn, list, rename,
    startAutofill: (call: AuthCall) => startSignIn(call),
    startAdd: (call: AuthCall) => startManagement(call, ADD_PASSKEY_PURPOSE), verifyAdd, finishAdd,
    startRemove: (call: AuthCall, passkeyId: string) => startManagement(call, REMOVE_PASSKEY_PURPOSE, passkeyId), finishRemove,
  };
}

export type UsernamePasskeyMethod = ReturnType<typeof setupUsernamePasskey>;
