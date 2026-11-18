import type * as Effect from "effect/Effect";
import type { TransactionConflict, TransactionTooLarge } from "../../db/errors.js";
import type { ensureTables } from "../runtime/index.js";
import type { IdentityImportFailure } from "../import/sources.js";
import type { MethodDisabled } from "../methods/settings.js";

/** Shared failures for Auth methods and their transactions. */
export type AuthFailure = TransactionConflict | TransactionTooLarge | MethodDisabled;

/** What starting Auth (creating its tables and its first signing key) can fail with. */
export type AuthStartupFailure = Effect.Error<ReturnType<typeof ensureTables>> | AuthFailure | IdentityImportFailure;
