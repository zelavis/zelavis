/**
 * Importing accounts from another system's export (Firebase Auth, Supabase
 * `auth.users`, Django, a spreadsheet). Zelavis-own, moved from Identity's
 * `account-import.ts`.
 *
 * An account carries over with its username or verified email, display name
 * and metadata, and with its password whenever its hash is one Zelavis can
 * verify: PBKDF2-SHA256 in Zelavis's PHC form, Identity's earlier form, or Django's `pbkdf2_sha256`
 * (converted without loss, at least 100,000 iterations); bcrypt, Django's
 * `bcrypt_sha256`, scrypt and Firebase's modified scrypt, kept as they are and
 * replaced by Zelavis's own hash at the owner's first sign-in
 * (`rehashOnSignIn`). Any other hash leaves the account without a password:
 * its owner recovers one (`needsReset`).
 *
 * An email identifies an account here only once verified (I4), so an
 * imported email must be marked `verified`; an unverified one is a problem
 * of its row, never silently dropped.
 *
 * Planning validates the input and checks held identifiers in bounded queries.
 * With any problem or `dryRun`, nothing is written. Each account is then created in its own
 * transaction, account, identifier and password together, so a cut-off import
 * leaves whole accounts only, and running it again skips what it already
 * created (its identifiers are held).
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import { type AdministrationContext, refuse, resolveActor } from "../access/delegation.js";
import { createAdmittedAccount } from "../accounts/accounts.js";
import { creatableRoles } from "./accounts.js";
import type { AuthCall, AuthTx, CoreRuntime } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import { addressTakenError } from "../email/challenge/common.js";
import { emailTables } from "../email/tables.js";
import { normalizeEmail, validateEmailFormat } from "../email/validation.js";
import { type FirebaseHashConfig, legacyPasswordHash } from "../password/legacy.js";
import { _internal_dangerous_setPassword } from "../password/public.js";
import { invariant } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { getUserIdByUsername, setUsername } from "../username/public.js";
import { validateUsernameFormat } from "../username/validation.js";

export type { FirebaseHashConfig } from "../password/legacy.js";

export interface ImportedAccount {
  readonly email?: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly verified?: boolean;
  readonly metadata?: Record<string, unknown>;
  /** The source's password hash, if it has one; see the module comment for which carry over. */
  readonly passwordHash?: string;
  /** The hash's salt when the source exports it separately (Firebase), base64. */
  readonly passwordSalt?: string;
}

export interface AccountImportInput {
  readonly accounts: ReadonlyArray<ImportedAccount>;
  readonly dryRun?: boolean;
  /** The source project's hash parameters, for a Firebase export. */
  readonly hashConfig?: FirebaseHashConfig;
}

export interface AccountImportResult {
  readonly dryRun: boolean;
  readonly accounts: number;
  readonly created: number;
  /** Rows skipped because their email or username is already held: 1-based row and the identifier. */
  readonly skipped: ReadonlyArray<{ readonly row: number; readonly identifier: string }>;
  /** Accounts whose password could not carry over; their owners recover it. */
  readonly needsReset: ReadonlyArray<string>;
  /** Accounts whose password carried over in its source's hash, replaced by Zelavis's own at first sign-in. */
  readonly rehashOnSignIn: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<{ readonly row: number; readonly reason: string }>;
}

export const MAX_IMPORTED_ACCOUNTS = 10_000;
// A row can read the verified email, its password reservation, and the username.
// Leave headroom under the transaction's 256-query limit for the actor check.
const IMPORT_LOOKUP_BATCH = 64;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** Metadata keys that name authority or runtime state; an import may not set them. */
const RESERVED_METADATA = new Set([
  "principalType", "serviceAccount", "tenantId", "registrationPending",
  "authenticationTransport", "sessionId", "serviceTokenId", "authentication", "authority", "projectId", "platformScopeId",
  "placementGeneration", "runtimeNodeId",
]);

export const hasReservedAccountMetadata = (metadata: Record<string, unknown>): boolean =>
  Object.keys(metadata).some((key) => RESERVED_METADATA.has(key));

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const PHC = /^\$pbkdf2-sha256\$i=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/u;

const pbkdf2PasswordHash = (hash: string): string | undefined => {
  const phc = PHC.exec(hash);
  if (phc !== null) {
    const iterations = Number(phc[1]);
    return Number.isSafeInteger(iterations) && iterations >= MIN_ITERATIONS && iterations <= MAX_ITERATIONS ? hash : undefined;
  }
  const parts = hash.split("$");
  if (parts.length !== 4) return undefined;
  const [algorithm, iterationsText, salt, digest] = parts as [string, string, string, string];
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return undefined;
  if (algorithm === "pbkdf2-sha256") return BASE64URL.test(salt) && BASE64URL.test(digest) ? hash : undefined;
  if (algorithm === "pbkdf2_sha256") {
    // Django: the salt is used as its UTF-8 bytes, the digest is standard base64 of 32 bytes.
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(digest) || salt.length === 0) return undefined;
    const raw = Uint8Array.from(atob(digest), (character) => character.charCodeAt(0));
    return `pbkdf2-sha256$${iterations}$${toBase64Url(new TextEncoder().encode(salt))}$${toBase64Url(raw)}`;
  }
  return undefined;
};

/** The hash as stored here when it can be verified here, else `undefined`. */
export const portablePasswordHash = (hash: string, options: { readonly salt?: string; readonly hashConfig?: FirebaseHashConfig } = {}): string | undefined =>
  pbkdf2PasswordHash(hash) ?? legacyPasswordHash(hash, options);

/** Zelavis's own PBKDF2 (PHC or Identity's earlier form): signs in without being replaced, unless its iterations differ. */
const isOwnHash = (hash: string) => hash.startsWith("pbkdf2-sha256$") || hash.startsWith("$pbkdf2-sha256$");

interface Planned {
  readonly row: number;
  readonly identifier: string;
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
  readonly hash?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate the input shape; answers an error message for a malformed one. */
export const importInputProblem = (input: unknown): string | undefined => {
  if (!isRecord(input) || !Array.isArray(input.accounts)) return "An account import is { accounts: [...], dryRun?, hashConfig? }.";
  const hashConfig = input.hashConfig;
  if (hashConfig !== undefined && (
    !isRecord(hashConfig) || hashConfig.algorithm !== "firebase-scrypt" ||
    typeof hashConfig.signerKey !== "string" || typeof hashConfig.saltSeparator !== "string" ||
    !Number.isSafeInteger(hashConfig.rounds) || !Number.isSafeInteger(hashConfig.memCost)
  )) {
    return 'hashConfig is { algorithm: "firebase-scrypt", signerKey, saltSeparator, rounds, memCost }.';
  }
  if (input.accounts.length > MAX_IMPORTED_ACCOUNTS) return `An import holds at most ${MAX_IMPORTED_ACCOUNTS} accounts; split it.`;
  return undefined;
};

function plan(input: AccountImportInput) {
  const problems: Array<{ row: number; reason: string }> = [];
  const seen = new Set<string>();
  const planned: Planned[] = [];
  for (const [index, account] of input.accounts.entries()) {
    const row = index + 1;
    if (!isRecord(account)) { problems.push({ row, reason: "is not an object" }); continue; }
    const email = typeof account.email === "string" ? account.email.trim() : undefined;
    const username = typeof account.username === "string" ? account.username.trim() : undefined;
    if (email !== undefined && validateEmailFormat(email) !== null) { problems.push({ row, reason: `"${account.email}" is not an email address` }); continue; }
    if (email !== undefined && account.verified !== true) {
      problems.push({ row, reason: "has an email that is not verified; an email identifies an account only once verified" });
      continue;
    }
    if (username !== undefined && validateUsernameFormat(username) !== null) { problems.push({ row, reason: `"${account.username}" is not a valid username` }); continue; }
    const identifier = email === undefined ? username?.toLowerCase() : normalizeEmail(email);
    if (identifier === undefined || identifier === "") { problems.push({ row, reason: "has neither an email nor a username" }); continue; }
    const keys = [...(email === undefined ? [] : [`email:${normalizeEmail(email)}`]), ...(username === undefined ? [] : [`username:${username.toLowerCase()}`])];
    if (keys.some((key) => seen.has(key))) { problems.push({ row, reason: `repeats ${identifier}, which an earlier row has` }); continue; }
    for (const key of keys) seen.add(key);
    if (account.metadata !== undefined && !isRecord(account.metadata)) { problems.push({ row, reason: "metadata is not an object" }); continue; }
    if (account.metadata !== undefined && hasReservedAccountMetadata(account.metadata)) {
      problems.push({ row, reason: "metadata contains a reserved identity field" }); continue;
    }
    if (account.displayName !== undefined && typeof account.displayName !== "string") { problems.push({ row, reason: "displayName is not a string" }); continue; }
    const hash = typeof account.passwordHash === "string"
      ? portablePasswordHash(account.passwordHash, {
        ...(typeof account.passwordSalt === "string" ? { salt: account.passwordSalt } : {}),
        ...(input.hashConfig === undefined ? {} : { hashConfig: input.hashConfig }),
      })
      : undefined;
    planned.push({
      row,
      identifier,
      ...(username === undefined ? {} : { username }),
      ...(email === undefined ? {} : { email }),
      ...(typeof account.displayName === "string" ? { displayName: account.displayName } : {}),
      ...(account.metadata === undefined ? {} : { metadata: account.metadata }),
      ...(hash === undefined ? {} : { hash }),
    });
  }
  return { problems, planned };
}

const identifierIsHeld = Effect.fn("auth.admin.import.identifierIsHeld")(function* (tx: AuthTx, item: Planned) {
  if (item.email !== undefined && (yield* addressTakenError(tx, normalizeEmail(item.email))) !== null) return true;
  return item.username !== undefined && (yield* getUserIdByUsername(tx, { username: item.username })) !== null;
});

/** One planned account in its own transaction; a row that became held meanwhile is skipped. */
const createOne = Effect.fn("auth.admin.import.createOne")(function* (tx: AuthTx, actorId: string, role: string, item: Planned) {
  if (yield* identifierIsHeld(tx, item)) return false;
  const passwordState = item.hash === undefined ? "needs-reset" : isOwnHash(item.hash) ? "carried" : "rehash-on-sign-in";
  const userId = yield* createAdmittedAccount(tx, {
    kind: "human",
    displayName: item.displayName,
    roles: [role],
    permissions: [],
    grants: [],
    metadata: { ...(item.metadata ?? {}), "zelavis.import": { importedAt: new Date(tx.now).toISOString(), password: passwordState } },
  });
  if (item.username !== undefined) {
    const saved = yield* setUsername(tx, { userId, username: item.username });
    if (!saved.success) return yield* invariant(`The planned username was refused: ${saved.userError.error}`);
  }
  if (item.email !== undefined) {
    yield* tx.db.insert(emailTables.verifiedEmails, { email: item.email, normalizedEmail: normalizeEmail(item.email), userId, isPrimary: true });
  }
  if (item.hash !== undefined) yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC: item.hash, imported: true });
  yield* recordSecurityEvent(tx, { kind: "account.imported", accountId: userId, actorId, detail: { password: passwordState } });
  return true;
});

/**
 * Import `input`, as `principal` may: the actor needs to manage accounts here.
 * Answers the report, or a refusal.
 */
export const importAccounts = Effect.fn("auth.admin.import")(function* (
  runtime: CoreRuntime,
  call: AuthCall,
  args: { readonly principal: ZelavisPrincipal | undefined; readonly context: AdministrationContext; readonly input: AccountImportInput },
): Effect.fn.Return<{ readonly ok: true; readonly result: AccountImportResult } | ReturnType<typeof refuse>, AuthFailure> {
  const { input } = args;
  const actor = yield* runtime.query(call, (tx) => resolveActor(tx, args.principal, args.context));
  if (actor === null) return refuse("account_access_forbidden");
  const { problems, planned: candidates } = plan(input);
  const skipped: Array<{ row: number; identifier: string }> = [];
  const planned: Planned[] = [];
  for (let offset = 0; offset < candidates.length; offset += IMPORT_LOOKUP_BATCH) {
    const batch = candidates.slice(offset, offset + IMPORT_LOOKUP_BATCH);
    const held = yield* runtime.query(call, (tx) => Effect.gen(function* () {
      if ((yield* resolveActor(tx, args.principal, args.context)) === null) return null;
      return yield* Effect.forEach(batch, (item) => identifierIsHeld(tx, item));
    }));
    if (held === null) return refuse("account_access_forbidden");
    for (const [index, item] of batch.entries()) {
      if (held[index]) skipped.push({ row: item.row, identifier: item.identifier });
      else planned.push(item);
    }
  }
  const dryRun = input.dryRun === true;
  const needsReset = planned.filter((item) => item.hash === undefined).map((item) => item.identifier);
  const rehashOnSignIn = planned.filter((item) => item.hash !== undefined && !isOwnHash(item.hash)).map((item) => item.identifier);
  const report = (created: number, extraSkipped: ReadonlyArray<{ row: number; identifier: string }> = []): AccountImportResult => ({
    dryRun,
    accounts: input.accounts.length,
    created,
    skipped: [...skipped, ...extraSkipped],
    needsReset: problems.length > 0 ? [] : needsReset,
    rehashOnSignIn: problems.length > 0 ? [] : rehashOnSignIn,
    problems,
  });
  if (dryRun || problems.length > 0) return { ok: true, result: report(0) } as const;
  let created = 0;
  const lateSkips: Array<{ row: number; identifier: string }> = [];
  for (const item of planned) {
    const made = yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      // The actor must still be allowed for every account it creates.
      if ((yield* resolveActor(tx, args.principal, args.context)) === null) return null;
      return yield* createOne(tx, actor.id, creatableRoles(args.context)[0]!, item);
    }));
    if (made === null) return refuse("account_access_forbidden");
    if (made) created += 1;
    else lateSkips.push({ row: item.row, identifier: item.identifier });
  }
  return { ok: true, result: report(created, lateSkips) } as const;
});
