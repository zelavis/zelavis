/**
 * Importing accounts from another system's export (Firebase Auth, Supabase `auth.users`, Django, a spreadsheet).
 *
 * An account carries over with its email or username, display name, verification and metadata, and with its
 * password whenever its hash is one Zelavis can verify:
 * - PBKDF2-SHA256 in Zelavis's own format or Django's `pbkdf2_sha256`, converted without loss (at least 100,000
 *   iterations);
 * - bcrypt (`$2a$`, `$2b$`, `$2y$`: Supabase, Laravel, Devise), Django's `bcrypt_sha256`, scrypt (Django's
 *   `scrypt$…`) and Firebase's modified scrypt (with the project's `hashConfig` and each account's
 *   `passwordSalt`). These are kept as they are and replaced by Zelavis's own hash at their owner's first sign-in
 *   (`legacy-password.ts`); the report lists them in `rehashOnSignIn`.
 * Any other hash cannot be verified here, so the account gets a password credential with no hash: signing in fails
 * until its owner recovers the password through the ordinary recovery flow, and the report lists it in
 * `needsReset`. A hash is never stored in a form sign-in would misread.
 *
 * `dryRun` checks everything and writes nothing. An account whose email or username is already held is skipped,
 * so an import repeated after it was cut off creates only what is still missing. Each account and its credential
 * are written together or not at all: a credential refused removes the account it was for.
 */
import { Effect } from "effect";
import { integrationValue, present, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import type { Account } from "./domain/entities.js";
import type { AccountService } from "./services/account-service.js";
import type { CredentialService } from "./services/credential-service.js";
import { PASSWORD_PROVIDER } from "./providers/password.js";
import { legacyPasswordHash, type FirebaseHashConfig } from "./core/legacy-password.js";

export type { FirebaseHashConfig } from "./core/legacy-password.js";

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

const MAX_ACCOUNTS = 10_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

/** The hash as stored here when it can be verified here, else `undefined`. */
export const portablePasswordHash = (hash: string, options: { readonly salt?: string; readonly hashConfig?: FirebaseHashConfig } = {}): string | undefined =>
  pbkdf2PasswordHash(hash) ?? legacyPasswordHash(hash, options);

const pbkdf2PasswordHash = (hash: string): string | undefined => {
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

const id = (kind: string) => `${kind}_${crypto.randomUUID().replaceAll("-", "")}`;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

export function importAccounts(
  services: { readonly accounts: AccountService; readonly credentials: CredentialService },
  input: AccountImportInput,
): Promise<AccountImportResult> {
  return present(Effect.gen(function* (): Effect.fn.Return<AccountImportResult, IntegrationFailure> {
    if (input === null || typeof input !== "object" || !Array.isArray(input.accounts)) throw new TypeError("An account import is { accounts: [...], dryRun?, hashConfig? }.");
    const hashConfig = input.hashConfig;
    if (hashConfig !== undefined && (hashConfig === null || typeof hashConfig !== "object" || hashConfig.algorithm !== "firebase-scrypt")) {
      throw new TypeError('hashConfig is { algorithm: "firebase-scrypt", signerKey, saltSeparator, rounds, memCost }.');
    }
    if (input.accounts.length > MAX_ACCOUNTS) throw new TypeError(`An import holds at most ${MAX_ACCOUNTS} accounts; split it.`);
    const dryRun = input.dryRun === true;
    const problems: Array<{ row: number; reason: string }> = [];
    const skipped: Array<{ row: number; identifier: string }> = [];
    const needsReset: string[] = [];
    const rehashOnSignIn: string[] = [];
    const seen = new Set<string>();
    const planned: Array<{ row: number; account: ImportedAccount; identifier: string; hash: string | undefined }> = [];
    for (const [index, account] of input.accounts.entries()) {
      const row = index + 1;
      if (account === null || typeof account !== "object") { problems.push({ row, reason: "is not an object" }); continue; }
      const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : undefined;
      const username = typeof account.username === "string" ? account.username.trim().toLowerCase() : undefined;
      if (email !== undefined && !EMAIL.test(email)) { problems.push({ row, reason: `"${account.email}" is not an email address` }); continue; }
      const identifier = email ?? username;
      if (identifier === undefined || identifier === "") { problems.push({ row, reason: "has neither an email nor a username" }); continue; }
      if (seen.has(identifier)) { problems.push({ row, reason: `repeats ${identifier}, which an earlier row has` }); continue; }
      seen.add(identifier);
      if (account.metadata !== undefined && (account.metadata === null || typeof account.metadata !== "object" || Array.isArray(account.metadata))) {
        problems.push({ row, reason: "metadata is not an object" }); continue;
      }
      const held = email !== undefined ? yield* integrationValue(services.accounts.findByEmail(email)) : yield* integrationValue(services.accounts.findByUsername(username!));
      if (held !== null) { skipped.push({ row, identifier }); continue; }
      const hash = typeof account.passwordHash === "string"
        ? portablePasswordHash(account.passwordHash, {
          ...(typeof account.passwordSalt === "string" ? { salt: account.passwordSalt } : {}),
          ...(hashConfig === undefined ? {} : { hashConfig }),
        })
        : undefined;
      if (hash === undefined) needsReset.push(identifier);
      else if (!hash.startsWith("pbkdf2-sha256$")) rehashOnSignIn.push(identifier);
      planned.push({ row, account: { ...account, ...(email === undefined ? {} : { email }), ...(username === undefined ? {} : { username }) }, identifier, hash });
    }
    if (dryRun || problems.length > 0) {
      return { dryRun, accounts: input.accounts.length, created: 0, skipped, needsReset: problems.length > 0 ? [] : needsReset, rehashOnSignIn: problems.length > 0 ? [] : rehashOnSignIn, problems };
    }
    let created = 0;
    for (const { account, identifier, hash } of planned) {
      const made: Account = yield* integrationValue(services.accounts.create({
        id: id("account"),
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.username === undefined ? {} : { username: account.username }),
        ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
        verified: account.verified === true,
        metadata: { ...(account.metadata ?? {}), "zelavis.import": { importedAt: new Date().toISOString(), password: hash === undefined ? "needs-reset" : hash.startsWith("pbkdf2-sha256$") ? "carried" : "rehash-on-sign-in" } },
      }));
      yield* integrationValue(services.credentials.create({
        id: id("credential"), accountId: made.id, provider: PASSWORD_PROVIDER, identifier,
        ...(hash === undefined ? {} : { secretHash: hash }),
      })).pipe(Effect.tapError(() => integrationValue(services.accounts.delete(made.id)).pipe(Effect.orDie)));
      created += 1;
    }
    return { dryRun, accounts: input.accounts.length, created, skipped, needsReset, rehashOnSignIn, problems };
  }));
}
