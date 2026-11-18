/**
 * The MFA policy (Zelavis-own): which accounts must have a second factor
 * before they get a session, and the administrator's reset of an account's
 * second factor.
 *
 * The policy is one row of `totp_policy` in the runtime's own Auth partition,
 * so the Platform and each App have their own. No row reads as `none`.
 * `privileged` covers accounts whose access reaches administration: the
 * `owner` or `admin` role, or any `system.*` permission or grant.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TransactionTooLarge } from "../../db/errors.js";
import { invalidatePendingProofs } from "../accounts/proofs.js";
import type { Account } from "../accounts/tables.js";
import { accountsTables } from "../accounts/tables.js";
import { endAccountSessions } from "../core/sessions.js";
import type { AuthTxBase } from "../runtime/index.js";
import { activeSecrets, backupCodesByUserId, pendingSecret } from "./helpers.js";
import { totpTables } from "./tables.js";

export const MfaRequiredFor = Schema.Literals(["none", "privileged", "all"]);
export type MfaRequiredFor = typeof MfaRequiredFor.Type;

export const MfaPolicy = Schema.Struct({
  requiredFor: MfaRequiredFor,
  revision: Schema.Number,
});
export type MfaPolicy = typeof MfaPolicy.Type;

export const MfaPolicyInput = Schema.Struct({
  requiredFor: MfaRequiredFor,
  expectedRevision: Schema.Number,
});
export type MfaPolicyInput = typeof MfaPolicyInput.Type;

const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

export const DEFAULT_MFA_POLICY: MfaPolicy = { requiredFor: "none", revision: 0 };

const policyRow = (tx: AuthTxBase) => tx.db.query(totpTables.policy).unique();

/** The runtime's MFA policy. */
export const readPolicy = (tx: AuthTxBase): Effect.Effect<MfaPolicy, TransactionTooLarge> =>
  Effect.map(policyRow(tx), (row) => row === null ? DEFAULT_MFA_POLICY : { requiredFor: row.requiredFor, revision: row.revision });

/**
 * Change the policy when `expectedRevision` is the current one. A stale
 * revision answers `conflict` with the current policy, and writes nothing.
 */
export const setPolicy = Effect.fn("auth.totp.setPolicy")(function* (tx: AuthTxBase, input: MfaPolicyInput) {
  const row = yield* policyRow(tx);
  const current = row === null ? DEFAULT_MFA_POLICY : { requiredFor: row.requiredFor, revision: row.revision };
  if (current.revision !== input.expectedRevision) {
    return { success: false, conflict: current } as const;
  }
  const next: MfaPolicy = { requiredFor: input.requiredFor, revision: current.revision + 1 };
  if (row === null) yield* tx.db.insert(totpTables.policy, next);
  else yield* tx.db.replace(totpTables.policy, row._id, next);
  return { success: true, policy: next } as const;
});

/** Whether an account's access reaches administration. */
export const isPrivileged = (account: Pick<Account, "roles" | "permissions" | "grants">): boolean =>
  account.roles.some((role) => PRIVILEGED_ROLES.has(role)) ||
  account.permissions.some((permission) => permission.startsWith("system.")) ||
  account.grants.some((grant) => grant.permission.startsWith("system."));

/** Whether the policy requires this account to have a second factor. A missing account needs none: the core signs in only known ones. */
export const policyRequires = Effect.fn("auth.totp.policyRequires")(function* (tx: AuthTxBase, userId: string) {
  const policy = yield* readPolicy(tx);
  if (policy.requiredFor === "none") return false;
  if (policy.requiredFor === "all") return true;
  const account = yield* tx.db.get(accountsTables.accounts, userId);
  return account !== null && isPrivileged(account);
});

/**
 * Remove every second factor of an account: its TOTP secrets (pending and
 * active) and backup codes, end its sessions, and invalidate pending
 * authentication proofs in the same transaction. Does no
 * authorization: the administration route checks that the caller may manage
 * the account (part 11). Answers how many secrets were removed.
 */
export const resetSecondFactor = Effect.fn("auth.totp.resetSecondFactor")(function* (tx: AuthTxBase, userId: string) {
  const active = yield* activeSecrets(tx, userId);
  for (const row of active) yield* tx.db.delete(totpTables.totpSecrets, row._id);
  const pending = yield* pendingSecret(tx, userId);
  if (pending !== null) yield* tx.db.delete(totpTables.totpSecrets, pending._id);
  for (const row of yield* backupCodesByUserId(tx, userId)) yield* tx.db.delete(totpTables.backupCodes, row._id);
  yield* invalidatePendingProofs(tx, userId);
  yield* endAccountSessions(tx, userId);
  return active.length;
});
