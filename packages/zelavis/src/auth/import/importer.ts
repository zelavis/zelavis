/** Import while the prior engine's writer is fenced. Each source page and its
 * checkpoint commit together. Retrying reads only pages beyond the checkpoint. */
import * as Effect from "effect/Effect";
import { encryptSecret } from "../../edge/acme-crypto.js";
import { accountsTables, type Account } from "../accounts/tables.js";
import { importApplePrivateKey } from "../apple/secret.js";
import { ISSUER as APPLE_ISSUER } from "../apple/constants.js";
import { appleTables } from "../apple/tables.js";
import { bootstrapTables } from "../bootstrap/tables.js";
import type { RowOf } from "../core/tables.js";
import { emailByNormalizedEmail } from "../email/helpers.js";
import { emailReservation, emailReservationTables } from "../email/reservations.js";
import { normalizeEmail } from "../email/validation.js";
import { emailTables } from "../email/tables.js";
import { githubTables } from "../github/tables.js";
import { ISSUERS as GOOGLE_ISSUERS } from "../google/constants.js";
import { googleTables } from "../google/tables.js";
import { callbackPath } from "../lib/oauth/constants.js";
import { parseUrl } from "../lib/oauth/redemption.js";
import { connectionKey, type OAuthConnections } from "../oauth/connections.js";
import { oauthConnectionsTables, oauthTables } from "../oauth/tables.js";
import { supportsPasswordHash } from "../password/hashing.js";
import { passwordTables } from "../password/tables.js";
import { registrationTables } from "../registration/tables.js";
import { NO_REQUEST, type AuthRuntime, type AuthTxBase } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { serviceAccountTables } from "../serviceAccounts/tables.js";
import { usernameTables } from "../username/tables.js";
import { normalizeUsername } from "../username/validation.js";
import {
  decodeIdentity,
  IdentityImportFailure,
  IMPORT_PAGE_SIZE,
  type IdentityPage,
  type IdentitySource,
  LegacyAccount,
  LegacyConnection,
  LegacyCredential,
  LegacyRegistration,
  LegacySession,
} from "./sources.js";
import { importTables } from "./state.js";

type State = RowOf<typeof importTables.state>;
type Credential = typeof LegacyCredential.Type;
type Connection = typeof LegacyConnection.Type;
type LinkedProvider = "google" | "apple" | "github" | "oidc";
interface Link {
  readonly provider: LinkedProvider;
  readonly issuer?: string | undefined;
}

const nextPhase = {
  connections: "accounts",
  accounts: "credentials",
  credentials: "sessions",
  sessions: "qualify",
} as const;

const refuse = (message: string) => new IdentityImportFailure({ message });
const principal = (tx: AuthTxBase, accountId: string) => tx.db.query(importTables.principals)
  .withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique();
const password = (tx: AuthTxBase, userId: string) => tx.db.query(passwordTables.passwords)
  .withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
const currentState = (tx: AuthTxBase) => tx.db.query(importTables.state).first();
const isOwner = (account: Account) => account.kind === "human" && account.roles.includes("owner") && account.permissions.includes("*");

const secureUrl = (input: string): URL | null => {
  const url = parseUrl(input);
  if (url === null || url.username || url.password || url.hash) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url : null;
};

function supportedIssuer(provider: string, issuer: string | undefined): boolean {
  switch (provider) {
    case "github": return issuer === undefined;
    case "google": return issuer !== undefined && GOOGLE_ISSUERS.includes(issuer);
    case "apple": return issuer === APPLE_ISSUER;
    default: return issuer !== undefined && secureUrl(issuer) !== null;
  }
}

function provenLink(row: Credential): Link | undefined {
  if (row.secretHash !== undefined || row.metadata?.provider !== row.provider) return undefined;
  const issuer = typeof row.metadata.issuer === "string" ? row.metadata.issuer : undefined;
  if (!supportedIssuer(row.provider, issuer)) return undefined;
  switch (row.provider) {
    case "github": return /^\d+$/u.test(row.identifier) ? { provider: "github" } : undefined;
    case "google": return { provider: "google" };
    case "apple": return { provider: "apple" };
    default: return { provider: "oidc", issuer };
  }
}

function migratedConnection(row: Connection, masterSecret: string) {
  const { issuer, discovered, clientSecret, ...fields } = row;
  const redirect = secureUrl(fields.redirectUri);
  if (redirect === null || !redirect.pathname.endsWith(callbackPath(fields.provider))) return undefined;
  if (!supportedIssuer(fields.provider, issuer)) return undefined;

  // Preserve the discovery proof that Identity already obtained. Built-ins
  // use their fixed endpoints. The generic provider still validates every ID token.
  const builtin = fields.provider === "github" || fields.provider === "apple" || fields.provider === "google";
  if (!builtin && (discovered === undefined || discovered.issuer !== issuer ||
      ![discovered.authorizationEndpoint, discovered.tokenEndpoint, discovered.jwksUrl].every((url) => secureUrl(url) !== null))) return undefined;
  return {
    ...fields,
    revision: crypto.randomUUID(),
    issuer: builtin ? undefined : issuer,
    discovered: builtin || discovered === undefined ? undefined : { ...discovered, discoveredAt: Date.parse(fields.updatedAt) },
    sealedClientSecret: clientSecret ? { ...encryptSecret(clientSecret, connectionKey(masterSecret)) } : undefined,
  };
}

const writeAccount = Effect.fn("auth.import.account")(function* (tx: AuthTxBase, row: typeof LegacyAccount.Type) {
  if (row.registrationPending || row.metadata?.["zelavis.platform.bootstrapState"] === "pending") return null;

  const { id, email, verified, displayName, metadata } = row;
  const kind = metadata?.principalType === "service" ? "service" : "human";
  if ((yield* tx.db.get(accountsTables.accounts, id)) !== null) {
    return yield* refuse(`Identity account ${id} already exists in Auth.`);
  }
  const access = {
    roles: row.roles ?? [],
    permissions: row.permissions ?? [],
    grants: row.grants ?? [],
    accessRevision: row.accessRevision ?? 0,
  };
  yield* tx.db.insert(accountsTables.accounts, { kind, displayName, metadata, ...access }, id);
  if (kind === "service") {
    yield* tx.db.insert(importTables.principals, { accountId: id, sessionEpoch: row.sessionEpoch ?? 0 });
  } else if (email !== undefined && verified) {
    const normalizedEmail = normalizeEmail(email);
    if ((yield* emailByNormalizedEmail(tx, normalizedEmail)) !== null) {
      return yield* refuse(`Verified Identity email identifiers conflict for account ${id}.`);
    }
    yield* tx.db.insert(emailTables.verifiedEmails, { userId: id, email, normalizedEmail, isPrimary: true });
  }
  return { kind, ...access };
});

const writePassword = Effect.fn("auth.import.password")(function* (tx: AuthTxBase, credential: Credential, hash: string) {
  const { accountId, identifier } = credential;
  if ((yield* password(tx, accountId)) !== null) {
    return yield* refuse(`Identity account ${accountId} has more than one password credential.`);
  }
  if (identifier.includes("@")) {
    const normalizedEmail = normalizeEmail(identifier);
    const verified = yield* emailByNormalizedEmail(tx, normalizedEmail);
    if ((verified !== null && verified.userId !== accountId) ||
        (yield* emailReservation(tx, normalizedEmail)) !== null) {
      return yield* refuse(`Identity email login identifiers conflict for account ${accountId}.`);
    }
    if (verified === null) {
      yield* tx.db.insert(emailReservationTables.passwordReservations, { normalizedEmail, userId: accountId });
    }
  } else {
    const usernameNormalized = normalizeUsername(identifier);
    const taken = yield* tx.db.query(usernameTables.usernames)
      .withIndex("by_usernameNormalized", (q) => q.eq("usernameNormalized", usernameNormalized)).first();
    if (taken !== null) return yield* refuse(`Identity username login identifiers conflict for account ${accountId}.`);
    yield* tx.db.insert(usernameTables.usernames, { userId: accountId, username: identifier, usernameNormalized });
  }
  yield* tx.db.insert(passwordTables.passwords, { userId: accountId, passwordHashPHC: hash, imported: true });
});

const writeLink = Effect.fn("auth.import.oauthLink")(function* (tx: AuthTxBase, row: Credential, link: Link) {
  const userId = row.accountId;
  const providerAccountId = row.identifier;
  if (link.provider === "oidc") {
    const issuer = link.issuer;
    if (issuer === undefined) return yield* refuse("The imported OpenID Connect identity has no issuer proof.");
    const previous = yield* tx.db.query(oauthTables.accounts)
      .withIndex("by_issuer_providerAccountId", (q) => q.eq("issuer", issuer).eq("providerAccountId", providerAccountId)).first();
    if (previous === null) yield* tx.db.insert(oauthTables.accounts, { issuer, userId, providerAccountId });
    else if (previous.userId !== userId) return yield* refuse(`Verified OpenID Connect links conflict for account ${userId}.`);
    return;
  }
  const table = { google: googleTables.accounts, apple: appleTables.accounts, github: githubTables.accounts }[link.provider];
  const previous = yield* tx.db.query(table).withIndex("providerAccountId", (q) => q.eq("providerAccountId", providerAccountId)).first();
  if (previous === null) yield* tx.db.insert(table, { userId, providerAccountId });
  else if (previous.userId !== userId) return yield* refuse(`Verified OAuth links conflict for account ${userId}.`);
});

const writeServiceToken = Effect.fn("auth.import.serviceToken")(function* (tx: AuthTxBase, row: typeof LegacySession.Type) {
  const { accountId, tokenHash } = row;
  const account = yield* principal(tx, accountId);
  const expiresAt = Date.parse(row.expiresAt);
  if (account?.sessionEpoch === undefined || account.sessionEpoch !== (row.epoch ?? 0) || expiresAt <= tx.now) return;
  const byHash = yield* tx.db.query(serviceAccountTables.tokens)
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).first();
  if (byHash !== null) {
    if (byHash.accountId !== accountId) return yield* refuse(`Identity service tokens conflict for account ${accountId}.`);
    return;
  }
  // Respect the same bound as administration so every imported token is revocable.
  const existing = yield* tx.db.query(serviceAccountTables.tokens)
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId)).take(100);
  if (existing.length === 100) return yield* refuse(`Identity service account ${accountId} has more than 100 active tokens.`);
  yield* tx.db.insert(serviceAccountTables.tokens, { accountId, tokenHash, createdAt: Date.parse(row.createdAt), expiresAt });
});

interface ImportOptions {
  readonly runtime: AuthRuntime;
  readonly source: IdentitySource;
  /** Empties every Auth table and recreates them with fresh signing keys: the start of a rebuilt import. */
  readonly reset: () => Effect.Effect<void, IdentityImportFailure>;
  readonly role: "platform" | "project";
  readonly masterSecret: string;
  readonly connections: Pick<OAuthConnections, "read">;
}

const pageRecords = <T extends { readonly id: string }>(
  page: IdentityPage,
  decode: (value: unknown) => T | undefined,
) => page.records.flatMap(({ id, value }) => {
  const row = decode(value);
  return row?.id === id ? [row] : [];
});

const prepareConnections = (options: ImportOptions, page: IdentityPage) => page.records.flatMap(({ id, value }) => {
  const row = decodeIdentity(LegacyConnection, value);
  const connection = row?.provider === id ? migratedConnection(row, options.masterSecret) : undefined;
  return connection === undefined ? [] : [connection];
});

const prepareCredentials = Effect.fn("auth.import.prepareCredentials")(function* (options: ImportOptions, rows: ReadonlyArray<Credential>) {
  const connections = new Map<string, Effect.Success<ReturnType<OAuthConnections["read"]>>>();
  return yield* Effect.forEach(rows, (credential) => Effect.gen(function* () {
    const link = credential.provider === "password" ? undefined : provenLink(credential);
    if (link === undefined) return { credential, link, usable: false };
    const provider = credential.provider;
    if (!connections.has(provider)) {
      const connection = yield* options.connections.read(provider).pipe(
        Effect.mapError(() => refuse(`Could not read the Auth connection for provider ${provider} during import.`)),
      );
      connections.set(provider, connection);
    }
    const connection = connections.get(provider);
    const redirect = connection === undefined ? null : secureUrl(connection.redirectUri);
    const configured = connection?.enabled === true && Boolean(connection.clientSecret) &&
      redirect !== null && redirect.pathname.endsWith(callbackPath(provider)) &&
      (link.provider !== "oidc" || (connection.issuer === link.issuer && connection.discovered !== undefined)) &&
      (link.provider !== "apple" || (Boolean(connection.teamId) && Boolean(connection.keyId)));
    const usable = configured && (link.provider !== "apple" || (connection.clientSecret !== undefined &&
      (yield* importApplePrivateKey(connection.clientSecret).pipe(Effect.option))._tag === "Some"));
    return { credential, link, usable };
  }));
});

const matchesPage = (state: State | null, expected: State): state is State =>
  state?.status === "running" && state.phase === expected.phase && state.after === expected.after;

const checkpoint = (tx: AuthTxBase, state: State, after: string | undefined, updates: Partial<State>) =>
  tx.db.patch(importTables.state, state._id, {
    after,
    phase: after === undefined && state.phase !== "qualify" ? nextPhase[state.phase] : state.phase,
    ...updates,
  });

export function identityImporter(options: ImportOptions) {
  const { runtime, source } = options;
  /**
   * Whether an import must run. A recorded import, done or not, is kept only while the source is as it was when the
   * import began. A different fingerprint means a rollback gave the prior engine write authority again and it wrote:
   * its records are then the truth, so everything in Auth (including what was written here after the earlier
   * activation) is replaced by a new import from them, and the security log says so.
   */
  const prepare = Effect.fn("auth.import.prepare")(function* () {
    const recorded = yield* runtime.query(NO_REQUEST, currentState);
    const fingerprint = yield* source.fingerprint();
    let rebuiltFrom: State | undefined;
    if (recorded !== null) {
      if (recorded.status !== "resetting" && recorded.sourceFingerprint === fingerprint) return recorded.status === "running";
      if (recorded.status !== "resetting") {
        yield* runtime.mutation(NO_REQUEST, tx => tx.db.patch(importTables.state, recorded._id, { status: "resetting" }));
        yield* Effect.logWarning(
          "The prior Identity engine wrote after an Auth import began. Auth is rebuilt from its records. Auth changes from the previous activation are replaced.",
        );
      }
      yield* options.reset();
      rebuiltFrom = recorded;
    } else if (yield* runtime.query(NO_REQUEST, (tx) => Effect.map(tx.db.query(accountsTables.accounts).first(), (account) => account !== null))) {
      return false;
    }
    if (recorded === null && fingerprint === "") {
      // A fresh runtime has no source to page through. Keep its empty checkpoint so a later
      // rollback that adds prior-engine records still triggers a rebuild.
      return yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
        const state = yield* currentState(tx);
        if (state !== null) return state.status === "running";
        yield* tx.db.insert(importTables.state, {
          status: "done", phase: "qualify", imported: 0, skipped: 0, unprovenLinks: 0,
          bootstrapComplete: false, sourceFingerprint: fingerprint,
        });
        return false;
      }));
    }
    const settings = yield* source.settings();
    const registration = decodeIdentity(LegacyRegistration, settings.registration);
    return yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const state = yield* currentState(tx);
      if (state !== null && state.status !== "resetting") return state.status === "running";
      if ((yield* tx.db.query(accountsTables.accounts).first()) !== null) {
        if (state?.status === "resetting") return yield* refuse("Accounts remained in Auth after its import rebuild reset.");
        return false;
      }
      if (registration !== undefined) yield* tx.db.insert(registrationTables.policy, { enabled: registration.enabled, revision: registration.revision });
      const next = {
        status: "running", phase: "connections", imported: 0, unprovenLinks: 0,
        skipped: settings.registration !== undefined && registration === undefined ? 1 : 0,
        bootstrapComplete: settings.bootstrapComplete,
        sourceFingerprint: fingerprint,
      } as const;
      if (state === null) yield* tx.db.insert(importTables.state, next);
      else yield* tx.db.replace(importTables.state, state._id, next);
      if (rebuiltFrom !== undefined) {
        yield* recordSecurityEvent(tx, { kind: "identity.import_rebuilt", detail: { previous: rebuiltFrom.status, previousImported: rebuiltFrom.imported } });
      }
      return true;
    }));
  });

  const runPage = Effect.fn("auth.import.page")(function* (state: State) {
    const phase = state.phase;
    if (phase === "qualify") {
      yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
        if (!matchesPage(yield* currentState(tx), state)) return;
        const remaining = yield* tx.db.query(importTables.principals).take(IMPORT_PAGE_SIZE);
        for (const row of remaining) {
          if (row.oauth === false && (yield* password(tx, row.accountId)) === null) {
            return yield* refuse(`Identity account ${row.accountId} has no qualified sign-in path. Restore access in Identity before upgrading.`);
          }
          if (row.needsRelink) {
            yield* recordSecurityEvent(tx, { kind: "identity.oauth_relink_required", accountId: row.accountId });
          }
          yield* tx.db.delete(importTables.principals, row._id);
        }
        if (remaining.length === IMPORT_PAGE_SIZE) return;
        if (state.owner !== undefined) {
          if ((yield* password(tx, state.owner.accountId)) === null) return yield* refuse("The existing Platform owner has no usable password credential.");
          yield* tx.db.insert(bootstrapTables.claims, { accountId: state.owner.accountId });
        } else if (state.bootstrapComplete) {
          return yield* refuse("The completed Platform Identity claim has no existing owner account.");
        }
        yield* recordSecurityEvent(tx, {
          kind: "identity.imported",
          detail: { imported: state.imported, skipped: state.skipped, unprovenLinks: state.unprovenLinks },
        });
        yield* tx.db.patch(importTables.state, state._id, { status: "done" });
      }));
      return;
    }

    const page = yield* source.pages(phase, state.after);
    if (page.records.length > IMPORT_PAGE_SIZE || (page.next !== undefined && page.next === state.after)) {
      return yield* refuse(`The Identity ${phase} source did not return a bounded, advancing page.`);
    }

    switch (phase) {
      case "connections": {
        const rows = prepareConnections(options, page);
        yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          if (!matchesPage(yield* currentState(tx), state)) return;
          for (const row of rows) yield* tx.db.insert(oauthConnectionsTables.connections, row);
          yield* checkpoint(tx, state, page.next, { skipped: state.skipped + page.records.length - rows.length });
        }));
        break;
      }
      case "accounts": {
        const rows = pageRecords(page, (value) => decodeIdentity(LegacyAccount, value));
        yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          if (!matchesPage(yield* currentState(tx), state)) return;
          let imported = 0;
          let owner = state.owner;
          for (const row of rows) {
            const account = yield* writeAccount(tx, row);
            if (account === null) continue;
            imported += 1;
            const createdAt = Date.parse(row.createdAt);
            if (options.role === "platform" && account.kind === "human" && account.roles.includes("owner") &&
                account.permissions.includes("*") && (owner === undefined || createdAt < owner.createdAt)) {
              owner = { accountId: row.id, createdAt, bootstrapSession: false };
            }
          }
          yield* checkpoint(tx, state, page.next, {
            imported: state.imported + imported, skipped: state.skipped + page.records.length - imported, owner,
          });
        }));
        break;
      }
      case "credentials": {
        const rows = yield* prepareCredentials(options, pageRecords(page, (value) => decodeIdentity(LegacyCredential, value)));
        yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          if (!matchesPage(yield* currentState(tx), state)) return;
          let skipped = page.records.length - rows.length;
          let unprovenLinks = 0;
          for (const { credential, link, usable } of rows) {
            const account = yield* tx.db.get(accountsTables.accounts, credential.accountId);
            if (account?.kind !== "human") { skipped += 1; continue; }
            if (credential.provider === "password") {
              if (credential.secretHash === undefined || !supportsPasswordHash(credential.secretHash)) skipped += 1;
              else yield* writePassword(tx, credential, credential.secretHash);
              continue;
            }
            if (link !== undefined) yield* writeLink(tx, credential, link);
            else unprovenLinks += 1;
            const previous = yield* principal(tx, credential.accountId);
            const needsRelink = link === undefined;
            if (previous === null) {
              yield* tx.db.insert(importTables.principals, { accountId: credential.accountId, oauth: usable, needsRelink });
            } else if ((usable && !previous.oauth) || (needsRelink && !previous.needsRelink)) {
              yield* tx.db.patch(importTables.principals, previous._id, {
                oauth: usable || previous.oauth === true, needsRelink: needsRelink || previous.needsRelink === true,
              });
            }
          }
          yield* checkpoint(tx, state, page.next, { skipped: state.skipped + skipped, unprovenLinks: state.unprovenLinks + unprovenLinks });
        }));
        break;
      }
      case "sessions": {
        const rows = pageRecords(page, (value) => decodeIdentity(LegacySession, value));
        yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          if (!matchesPage(yield* currentState(tx), state)) return;
          let owner = state.owner;
          for (const row of rows) {
            if (row.metadata?.bootstrap === true && options.role === "platform" && !owner?.bootstrapSession) {
              const account = yield* tx.db.get(accountsTables.accounts, row.accountId);
              if (account !== null && isOwner(account)) owner = { accountId: row.accountId, createdAt: Date.parse(row.createdAt), bootstrapSession: true };
            } else if (row.status === "active" && row.metadata?.serviceAccount === true && row.metadata.authentication === "service-token") {
              yield* writeServiceToken(tx, row);
            }
          }
          yield* checkpoint(tx, state, page.next, { owner, skipped: state.skipped + page.records.length - rows.length });
        }));
        break;
      }
    }
  });

  const run = Effect.fn("auth.import.run")(function* () {
    // Yield between pages so a Project can serve its importing response and stop promptly.
    for (;;) {
      const state = yield* runtime.query(NO_REQUEST, currentState);
      if (state === null || state.status === "done") return;
      yield* runPage(state);
      yield* Effect.yieldNow;
    }
  });

  return { prepare, run };
}
