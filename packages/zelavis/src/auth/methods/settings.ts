import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AuthTxBase, defineTable, defineTables } from "../runtime/index.js";

export const methodsTables = defineTables("methods", {
  settings: defineTable({
    enabled: Schema.Array(Schema.String),
    revision: Schema.Number,
    // Enabled methods retain their revision until they are disabled.
    methodRevisions: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  }),
});

export class MethodDisabled extends Schema.TaggedError<MethodDisabled>()("MethodDisabled", {}) {}

export const methodSettingsRow = (tx: AuthTxBase) => tx.db.query(methodsTables.settings).unique();

const BUILT_IN_OAUTH = new Set(["google", "apple", "github"]);
const PASSWORD_OR_PASSKEY = new Set(["usernamePassword", "emailPassword", "usernamePasskey"]);

/** The current settings revision, or null when this method is disabled. Internal methods have no settings. */
export const readMethodRevision = Effect.fn("auth.methods.readRevision")(function* (tx: AuthTxBase, method: string) {
  const name = BUILT_IN_OAUTH.has(method) ? `oauth:${method}` : method;
  if (!PASSWORD_OR_PASSKEY.has(name) && !name.startsWith("oauth:")) return 0;
  const saved = yield* methodSettingsRow(tx);
  if (saved === null) return 0;
  return saved.enabled.includes(name) ? saved.methodRevisions?.[name] ?? saved.revision : null;
});
