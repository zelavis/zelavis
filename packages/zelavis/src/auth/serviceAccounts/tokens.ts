/**
 * Service-account bearer tokens (Zelavis-own, moved from Identity's service
 * sessions): `zvs_` and 32 random bytes in base64url, the format Identity
 * issued, stored as the SHA-256 of the whole token in base64url. A token is
 * valid until it expires or is revoked; every request reads its row, so a
 * revoked token stops authenticating at once (I3).
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import { accountsTables, type Account } from "../accounts/tables.js";
import { type AuthTxBase, sha256Base64Url } from "../runtime/index.js";
import { serviceAccountTables } from "./tables.js";

export const SERVICE_TOKEN_PREFIX = "zvs_";
const SERVICE_TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SERVICE_TOKEN_DEFAULT_DAYS = 90;
export const SERVICE_TOKEN_MAX_DAYS = 3650;
/** The most tokens one account holds; rotating replaces them all. */
const TOKENS_PER_ACCOUNT = 100;

export function isServiceToken(token: string, projectAudience?: string): boolean {
  if (!token.startsWith(SERVICE_TOKEN_PREFIX)) return false;
  const scopedPrefix = projectAudience === undefined ? undefined : `zvs_app_${projectAudience}_`;
  const prefix = scopedPrefix !== undefined && token.startsWith(scopedPrefix) ? scopedPrefix : SERVICE_TOKEN_PREFIX;
  return SERVICE_TOKEN_BODY.test(token.slice(prefix.length));
}

const randomToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${SERVICE_TOKEN_PREFIX}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
};

/** Issue a token for `accountId`, valid `days` days. Answers the token itself, once. */
export const issueServiceToken = Effect.fn("auth.serviceAccounts.issue")(function* (tx: AuthTxBase, accountId: string, days: number) {
  const token = randomToken();
  const expiresAt = tx.now + days * DAY_MS;
  const id = yield* tx.db.insert(serviceAccountTables.tokens, { accountId, tokenHash: yield* sha256Base64Url(token), createdAt: tx.now, expiresAt });
  return { token, tokenId: id, expiresAt };
});

/** Service tokens belonging to the account, bounded by the per-account cap. */
export const serviceTokensOfAccount = (tx: AuthTxBase, accountId: string) =>
  tx.db.query(serviceAccountTables.tokens).withIndex("by_accountId", (q) => q.eq("accountId", accountId)).order("desc").take(TOKENS_PER_ACCOUNT);

/** Remove the named token or all tokens of the account. Answers the IDs removed. */
export const revokeServiceTokens = Effect.fn("auth.serviceAccounts.revokeTokens")(function* (tx: AuthTxBase, accountId: string, tokenId?: string) {
  const rows = yield* serviceTokensOfAccount(tx, accountId);
  const ids = rows.filter((row) => tokenId === undefined || row._id === tokenId).map((row) => row._id);
  for (const id of ids) yield* tx.db.delete(serviceAccountTables.tokens, id);
  return ids;
});

/** The account and token row a presented token names, while it is live. */
export const resolveServiceToken = Effect.fn("auth.serviceAccounts.resolve")(function* (tx: AuthTxBase, token: string, projectAudience?: string) {
  if (!isServiceToken(token, projectAudience)) return null;
  const tokenHash = yield* sha256Base64Url(token);
  const row = yield* tx.db.query(serviceAccountTables.tokens).withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).first();
  if (row === null || row.expiresAt <= tx.now) return null;
  const account = yield* tx.db.get(accountsTables.accounts, row.accountId);
  if (account === null || account.kind !== "service") return null;
  return { account, tokenId: row._id, expiresAt: row.expiresAt };
});

/** The principal a service token stands for: the account's access, marked as a service token rather than a session. */
export function serviceAccountPrincipal(account: Account, tokenId: string, projectId?: string): ZelavisPrincipal {
  return {
    id: account._id,
    type: "service",
    roles: [...account.roles],
    permissions: projectId ? undefined : [...account.permissions],
    grants: [
      ...account.grants.map((grant) => ({ ...grant })),
      ...(projectId ? account.permissions.map((permission) => ({ permission, scope: { type: "project" as const, projectId } })) : []),
    ],
    metadata: {
      ...(account.metadata ?? {}),
      serviceTokenId: tokenId,
      authentication: "service-token",
      authenticationTransport: "bearer",
      ...(projectId ? { projectId } : {}),
    },
  };
}
