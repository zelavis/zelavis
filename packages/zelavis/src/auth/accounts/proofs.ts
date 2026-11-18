import * as Effect from "effect/Effect";
import type { AuthTxBase } from "../runtime/index.js";
import { accountsTables } from "./tables.js";

/** The credential revision a new proof must carry. A missing account cannot hold a proof. */
export const readProofRevision = Effect.fn("auth.accounts.readProofRevision")(function* (tx: AuthTxBase, userId: string) {
  const account = yield* tx.db.get(accountsTables.accounts, userId);
  return account === null ? null : account.proofRevision ?? 0;
});

/** End outstanding proofs without scanning their rows. Call in the credential-changing transaction. */
export const invalidatePendingProofs = Effect.fn("auth.accounts.invalidatePendingProofs")(function* (tx: AuthTxBase, userId: string) {
  const revision = yield* readProofRevision(tx, userId);
  if (revision !== null) yield* tx.db.patch(accountsTables.accounts, userId, { proofRevision: revision + 1 });
});
