/**
 * The request authenticator every runtime uses (Zelavis-own).
 *
 * A request names a session through an access token: a bearer header, or the
 * access cookie. A bearer token in the service-account format (`zvs_…`) is
 * looked up by its hash instead and names a service account. The token's signature and times are checked against the
 * runtime's key set (no database read); then the session row is read, so a
 * revoked session stops authenticating at once (I3); then the account, whose
 * roles, permissions and grants become the principal, its role assignments
 * expanded from the in-process role catalogue (no read per request; an
 * account without assignments never consults it). Anything else is
 * anonymous: a bad signature, another runtime's key, a wrong audience, a
 * missing session. An expired token is anonymous too, but the request is
 * marked so the route layer can answer `access_token_expired` and the page
 * knows to refresh.
 */
import * as Effect from "effect/Effect";
import { type ZelavisPrincipal, readAuthorizationCredential } from "../../core/index.js";
import type { AuthKeysAdmin } from "../keys/keys.js";
import { NO_REQUEST, type AuthRuntime } from "../runtime/index.js";
import { accountsModule } from "../accounts/accounts.js";
import { accountSessionPrincipal } from "../accounts/principal.js";
import type { RoleCatalogueCache } from "../roles/cache.js";
import { NO_ROLES } from "../roles/expand.js";
import { createCoreRuntime } from "./context.js";
import { readCookie } from "./cookies.js";
import { getSession } from "./public.js";
import { isServiceToken, resolveServiceToken, serviceAccountPrincipal } from "../serviceAccounts/tokens.js";

export interface AuthAuthenticator {
  /** The principal the request's access token stands for, or undefined. */
  readonly authenticate: (request: Request) => Effect.Effect<ZelavisPrincipal | undefined>;
  /** Whether `authenticate` found an expired access token on this request. */
  readonly expiredToken: (request: Request) => boolean;
}

export interface AuthAuthenticatorOptions {
  readonly runtime: AuthRuntime;
  readonly keys: AuthKeysAdmin;
  /** The access cookie's name. */
  readonly cookieName: string;
  /** Present in a Project runtime: the principal's permissions become grants scoped to it. */
  readonly projectId?: string | undefined;
  readonly projectAudience?: string | undefined;
  /** The runtime's custom roles, for accounts holding role assignments. */
  readonly roles?: RoleCatalogueCache | undefined;
}

export function createAuthAuthenticator(options: AuthAuthenticatorOptions): AuthAuthenticator {
  // The authenticator reads sessions and never signs anyone up.
  const core = createCoreRuntime(options.runtime, options.keys, []);
  const expired = new WeakSet<Request>();

  const authenticate = Effect.fn("auth.authenticate")(function* (request: Request) {
    const bearer = readAuthorizationCredential(request, "Bearer");
    const cookie = readCookie(request, options.cookieName);
    const token = bearer ?? cookie;
    // A service account's bearer token: looked up by its hash, its row read on every request.
    if (bearer !== undefined && isServiceToken(bearer, options.projectAudience)) {
      const service = yield* core.query(NO_REQUEST, (tx) => resolveServiceToken(tx, bearer, options.projectAudience)).pipe(Effect.orDie);
      return service === null ? undefined : serviceAccountPrincipal(service.account, service.tokenId, options.projectId);
    }
    // A JWT has three parts; anything else (another scheme's token) is not ours to judge.
    if (token === undefined || token.split(".").length !== 3) return undefined;
    const checked = yield* options.keys.verify(token);
    if (checked.kind === "expired") {
      expired.add(request);
      return undefined;
    }
    if (checked.kind !== "valid") return undefined;
    // The session is read on every request; it is the one database read a request costs.
    const resolved = yield* core.query(NO_REQUEST, (tx) => Effect.gen(function* () {
      const session = yield* getSession(tx, { sessionId: checked.sub });
      if (session === null) return null;
      const account = yield* accountsModule.get(tx, session.userId);
      return account === null ? null : { account, userId: session.userId };
    })).pipe(Effect.orDie);
    if (resolved === null) return undefined;
    const roles = (resolved.account.roleAssignments?.length ?? 0) > 0 && options.roles !== undefined ? yield* options.roles.current : NO_ROLES;
    return accountSessionPrincipal(resolved.account, checked.sub, bearer === undefined ? "cookie" : "bearer", options.projectId, roles);
  });

  return { authenticate, expiredToken: (request) => expired.has(request) };
}
