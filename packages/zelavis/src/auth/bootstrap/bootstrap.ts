/**
 * The first owner (Zelavis-own, moved from `platform/auth-bootstrap.ts`).
 *
 * A fresh Platform has one way in: `POST /auth/bootstrap` with the
 * installation's bootstrap token, a username and a password. The claim is one
 * transaction: it reads `bootstrap_claims`, and finding it empty creates the
 * owner (role `owner`, permission `*`), its username and password, the claim
 * row and the owner's first session. Two concurrent claims both read it empty;
 * the commit's read-set check refuses one, whose retry finds the claim and
 * answers `bootstrap_complete`. So exactly one owner exists, and nothing a
 * failed claim wrote survives: Identity's pending-account cleanup and claim
 * lease are not carried.
 */
import * as Effect from "effect/Effect";
import { recordSecurityEvent } from "../security/events.js";
import { accountsModule, createAdmittedAccount } from "../accounts/accounts.js";
import type { AuthCall, CoreRuntime } from "../core/context.js";
import type { AuthCore } from "../core/setup.js";
import { _internal_dangerous_setPassword } from "../password/public.js";
import { getUserIdByUsername, setUsername } from "../username/public.js";
import { type AuthTxBase, invariant } from "../runtime/index.js";
import { bootstrapTables } from "./tables.js";

export const OWNER_ROLES: ReadonlyArray<string> = ["owner"];
export const OWNER_PERMISSIONS: ReadonlyArray<string> = ["*"];

/** Whether the first owner is still to be created. */
export const bootstrapRequired = (tx: AuthTxBase) =>
  Effect.map(tx.db.query(bootstrapTables.claims).first(), (claim) => claim === null);

export function createBootstrap(core: AuthCore, runtime: CoreRuntime) {
  // The owner's first session is a sign-in of this method; later ones are username + password's.
  const bound = core.bindMethod<unknown>({
    name: "bootstrap",
    createUser: () => invariant("The bootstrap method creates its owner itself"),
    onSignIn: accountsModule.onSignIn,
  });

  const status = (call: AuthCall) => runtime.query(call, (tx) => Effect.map(bootstrapRequired(tx), (required) => ({ required })));

  /**
   * Claim the first owner. `passwordHashPHC` is hashed by the caller, outside
   * the transaction; the username is validated by the caller too.
   */
  const claim = Effect.fn("auth.bootstrap.claim")(function* (
    call: AuthCall,
    args: { readonly username: string; readonly passwordHashPHC: string; readonly displayName?: string | undefined },
  ) {
    return yield* bound.mutation(call, (tx, helpers) => Effect.gen(function* () {
      if (!(yield* bootstrapRequired(tx))) return { ok: false, code: "bootstrap_complete" } as const;
      // No account can hold the name yet, but the username module is the authority on its uniqueness.
      if ((yield* getUserIdByUsername(tx, { username: args.username })) !== null) return { ok: false, code: "username_taken" } as const;
      const userId = yield* createAdmittedAccount(tx, {
        kind: "human",
        displayName: args.displayName,
        roles: OWNER_ROLES,
        permissions: OWNER_PERMISSIONS,
        grants: [],
      });
      const saved = yield* setUsername(tx, { userId, username: args.username });
      if (!saved.success) return { ok: false, code: "invalid_username", userError: saved.userError } as const;
      yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC: args.passwordHashPHC });
      yield* tx.db.insert(bootstrapTables.claims, { accountId: userId });
      yield* recordSecurityEvent(tx, { kind: "bootstrap.owner_created", accountId: userId });
      const outcome = yield* helpers.completeSignIn(tx, { userId, profile: {}, authenticatedBy: "password" });
      return { ok: true, userId, outcome } as const;
    }));
  });

  return { status, claim };
}

export type Bootstrap = ReturnType<typeof createBootstrap>;
