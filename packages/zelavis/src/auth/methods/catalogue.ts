/**
 * The methods catalogue (Zelavis-own): which sign-in methods this runtime
 * offers and what each can do now, and the operator's choice of methods.
 *
 * `GET /auth/methods` is public, so a sign-in page asks it what to show. A
 * method is listed when it is enabled; `signIn`, `signUp` and `recovery` say
 * what it can do at this moment, with `reason` naming what stops the rest.
 * Email + password keeps `signIn` without email delivery, because imported
 * and already verified addresses must keep signing in; its sign-up and
 * recovery need delivery.
 *
 * The choice is one row of `methods_settings` (`{ enabled, revision }`);
 * without one, every method the runtime has is enabled. A disabled method's
 * sign-in, sign-up and recovery routes answer 404 `method_disabled`;
 * management of what an account already holds (changing a password, listing
 * passkeys) stays available.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisRouteContext, ZelavisServerRoute } from "../../core/index.js";
import { type AuthRuntime, type AuthTxBase, NO_REQUEST } from "../runtime/index.js";
import type { AuthCall } from "../core/context.js";
import type { ZelavisPrincipal } from "../../core/index.js";
import { type AdministrationContext, resolveSettingsActor } from "../access/delegation.js";
import { getAccount } from "../accounts/accounts.js";
import { bootstrapTables } from "../bootstrap/tables.js";
import { getUsername } from "../username/public.js";
import type { Registration } from "../registration/policy.js";
import type { PasskeySettings } from "../passkey/settings.js";
import type { OAuthMethod } from "./oauth.js";
import type { EmailPasswordMethod } from "./email-password.js";
import { integration, present } from "../../core/runtime/effect-boundary.js";
import { errorBody } from "../routes/errors.js";
import { recordSecurityEvent } from "../security/events.js";
import { methodSettingsRow, methodsTables, readMethodRevision } from "./settings.js";

const METHOD_NAME = /^(?:usernamePassword|emailPassword|usernamePasskey|oauth:[a-z0-9][a-z0-9_-]{0,63})$/u;

export const MethodsSettingsInputSchema = Schema.Struct({
  enabled: Schema.Array(Schema.String.check(Schema.isPattern(METHOD_NAME))).check(Schema.isMaxLength(64)),
  expectedRevision: Schema.Natural,
});
export type MethodsSettingsInput = typeof MethodsSettingsInputSchema.Type;

export type MethodReason = "email_unavailable" | "passkey_unconfigured" | "connection_disabled" | "registration_closed";

export interface MethodEntry {
  readonly name: string;
  readonly signIn: boolean;
  readonly signUp: boolean;
  readonly recovery: boolean;
  readonly reason?: MethodReason;
}

export interface MethodsSettings {
  readonly enabled: ReadonlyArray<string>;
  readonly revision: number;
}

export interface CatalogueOptions {
  readonly runtime: AuthRuntime;
  readonly registration: Registration;
  readonly passkeys: PasskeySettings;
  readonly oauth: OAuthMethod;
  readonly emailPassword: EmailPasswordMethod;
}

const ownerPasswordMethod = Effect.fn("auth.methods.ownerPasswordMethod")(function* (tx: AuthTxBase) {
  const claim = yield* tx.db.query(bootstrapTables.claims).first();
  if (claim === null || (yield* getAccount(tx, claim.accountId)) === null) return "usernamePassword";
  return (yield* getUsername(tx, { userId: claim.accountId })) === null ? "emailPassword" : "usernamePassword";
});

/** The method a route serves sign-in, sign-up or recovery for; undefined for every other route. */
export const methodOfRoute = (routeId: string, params: Readonly<Record<string, string>>): string | undefined => {
  if (routeId === "auth.usernamePassword.signUp" || routeId === "auth.usernamePassword.signIn") return "usernamePassword";
  if (/^auth\.emailPassword\.(?:signUp|completeSignUp|signIn|recoveryStart|recoveryCheck|recoveryComplete)$/u.test(routeId)) return "emailPassword";
  if (routeId.startsWith("auth.usernamePasskey.")) return "usernamePasskey";
  if (/^auth\.oauth\.(?:start|callback|callback\.form|redeem)$/u.test(routeId) && params.provider !== undefined) return `oauth:${params.provider}`;
  return undefined;
};

export function createMethodsCatalogue(options: CatalogueOptions) {
  const { runtime } = options;

  /** Every method this runtime has now, enabled or not. */
  const known = Effect.fn("auth.methods.known")(function* () {
    const providers = yield* options.oauth.providers();
    return [
      "usernamePassword",
      "emailPassword",
      "usernamePasskey",
      ...providers.map((provider) => `oauth:${provider.name}`),
    ];
  });

  const settings = Effect.fn("auth.methods.settings")(function* () {
    const saved = yield* runtime.query(NO_REQUEST, methodSettingsRow);
    return saved === null ? { enabled: yield* known(), revision: 0 } : { enabled: [...saved.enabled], revision: saved.revision };
  });

  const setSettings = Effect.fn("auth.methods.setSettings")(function* (
    call: AuthCall,
    principal: ZelavisPrincipal | undefined,
    administration: AdministrationContext,
    input: MethodsSettingsInput,
  ) {
    const defaults = yield* known();
    return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      const actor = yield* resolveSettingsActor(tx, principal, administration);
      if (actor === null) return { success: false, code: "account_access_forbidden" } as const;
      const saved = yield* methodSettingsRow(tx);
      const current = saved === null ? { enabled: defaults, revision: 0 } : { enabled: [...saved.enabled], revision: saved.revision };
      if (current.revision !== input.expectedRevision) return { success: false, conflict: current } as const;
      if (administration.authority === "platform" && !input.enabled.includes(yield* ownerPasswordMethod(tx))) {
        return { success: false, code: "owner_sign_in_required" } as const;
      }
      const next = { enabled: [...new Set(input.enabled)].sort(), revision: current.revision + 1 };
      if (saved !== null && next.enabled.length === current.enabled.length && next.enabled.every((name, index) => name === current.enabled[index])) {
        return { success: true, settings: current } as const;
      }
      const methodRevisions = Object.fromEntries(next.enabled.map((name) => [
        name,
        current.enabled.includes(name) ? saved?.methodRevisions?.[name] ?? current.revision : next.revision,
      ]));
      const persisted = { ...next, methodRevisions };
      if (saved === null) yield* tx.db.insert(methodsTables.settings, persisted);
      else yield* tx.db.replace(methodsTables.settings, saved._id, persisted);
      yield* recordSecurityEvent(tx, { kind: "methods.settings.changed", actorId: actor.id, detail: { enabled: next.enabled.join(",") } });
      return { success: true, settings: next } as const;
    }));
  });

  /**
   * Whether a method's routes serve: yes without a saved choice, and for a name the runtime does not have (its route
   * answers for itself, `unknown_provider` say); otherwise as the operator chose.
   */
  const isEnabled = Effect.fn("auth.methods.isEnabled")(function* (name: string) {
    if ((yield* runtime.query(NO_REQUEST, (tx) => readMethodRevision(tx, name))) !== null) return true;
    return name.startsWith("oauth:") && !(yield* known()).includes(name);
  });

  /** What each enabled method can do now, for the client this request comes from. */
  const list = Effect.fn("auth.methods.list")(function* (request: Request) {
    const current = yield* settings();
    const providers = new Set((yield* options.oauth.providers()).map((provider) => provider.name));
    const open = yield* runtime.query(NO_REQUEST, (tx) => options.registration.isOpen(tx));
    const emailUp = yield* options.emailPassword.emailAvailable();
    const passkeysUp = yield* options.passkeys.available(request);
    const entries: MethodEntry[] = [];
    const closed = (entry: MethodEntry): MethodEntry =>
      open || !entry.signUp ? entry : { ...entry, signUp: false, ...(entry.reason === undefined ? { reason: "registration_closed" as const } : {}) };
    for (const name of current.enabled) {
      if (name === "usernamePassword") {
        entries.push(closed({ name, signIn: true, signUp: true, recovery: false }));
      } else if (name === "emailPassword") {
        entries.push(closed(emailUp
          ? { name, signIn: true, signUp: true, recovery: true }
          : { name, signIn: true, signUp: false, recovery: false, reason: "email_unavailable" }));
      } else if (name === "usernamePasskey") {
        entries.push(closed(passkeysUp
          ? { name, signIn: true, signUp: true, recovery: false }
          : { name, signIn: false, signUp: false, recovery: false, reason: "passkey_unconfigured" }));
      } else if (name.startsWith("oauth:")) {
        entries.push(closed(providers.has(name.slice("oauth:".length))
          ? { name, signIn: true, signUp: true, recovery: false }
          : { name, signIn: false, signUp: false, recovery: false, reason: "connection_disabled" }));
      }
    }
    return { methods: entries, registration: { enabled: open } };
  });

  /** `routes` with each method route of a disabled method answering 404 `method_disabled`. */
  const gate = (routes: ReadonlyArray<ZelavisServerRoute>): ReadonlyArray<ZelavisServerRoute> =>
    routes.map((route) => ({
      ...route,
      handler: (context: ZelavisRouteContext) => {
        const name = methodOfRoute(route.id ?? "", context.params);
        if (name === undefined) return route.handler(context);
        return present(Effect.gen(function* () {
          if (!(yield* isEnabled(name))) return errorBody(404, "method_disabled", "That sign-in method is not enabled on this runtime.");
          return yield* integration(() => route.handler(context));
        }).pipe(Effect.catchTag("IntegrationFailure", (failure) => Effect.die(failure.cause))));
      },
    }));

  return { settings, setSettings, list, isEnabled, gate };
}

export type MethodsCatalogue = ReturnType<typeof createMethodsCatalogue>;
