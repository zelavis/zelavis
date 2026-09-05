import {
  readAuthorizationCredential,
  ZelavisAuthenticationError,
  type ZelavisPrincipal,
  type ZelavisRequestAuthenticator,
} from "../../../core/index.js";
import type { Account } from "../domain/entities.js";
import type { AccountService } from "../services/account-service.js";
import type { SessionService } from "../services/session-service.js";

export interface SessionAuthenticatorOptions {
  accounts: AccountService;
  sessions: SessionService;
  projectId?: string;
  cookieName?: string | false;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      if (!value) return undefined;
      try {
        return decodeURIComponent(value);
      } catch (cause) {
        throw new ZelavisAuthenticationError("Malformed session cookie.", {
          challenge: { scheme: "Bearer" },
          cause,
        });
      }
    }
  }
  return undefined;
}

function toPrincipal(
  account: Account,
  sessionId: string,
  transport: "bearer" | "cookie",
  projectId?: string,
): ZelavisPrincipal {
  const accountPermissions = account.permissions ?? [];
  return {
    id: account.id,
    type: "user",
    roles: account.roles,
    permissions: projectId ? undefined : accountPermissions,
    grants: [
      ...(account.grants ?? []),
      ...(projectId
        ? accountPermissions.map((permission) => ({
            permission,
            scope: { type: "project" as const, projectId },
          }))
        : []),
    ],
    metadata: {
      ...(account.metadata ?? {}),
      sessionId,
      authenticationTransport: transport,
      ...(projectId ? { projectId } : {}),
    },
  };
}

export function createSessionAuthenticator(
  options: SessionAuthenticatorOptions,
): ZelavisRequestAuthenticator {
  const cookieName = options.cookieName === undefined ? "zelavis_session" : options.cookieName;
  return {
    name: "zelavis-session",
    async authenticate(context) {
      const authorizationBearer = readAuthorizationCredential(context.request, "Bearer");
      const bearer = authorizationBearer?.startsWith("zvs_")
        ? authorizationBearer
        : undefined;
      const cookie = cookieName ? readCookie(context.request, cookieName) : undefined;
      if (bearer && cookie && bearer !== cookie) {
        throw new ZelavisAuthenticationError("Conflicting session credentials.", {
          challenge: { scheme: "Bearer" },
        });
      }
      const token = bearer ?? cookie;
      if (!token) return undefined;

      /**
       * A credential the caller chose to send is different from one the
       * browser attached on its own.
       *
       * A bearer token is an assertion: presenting an invalid one is an error
       * worth reporting. A session cookie is ambient — it rides along on every
       * request whether or not the caller meant to authenticate — so a stale
       * one means "not signed in", not "request refused".
       *
       * Rejecting on a stale cookie locked people out: the sign-in and
       * bootstrap endpoints are public, but a cookie left over from an expired
       * session, a revoked one, or another installation on the same host made
       * even those answer 401, and the only way through was clearing cookies
       * by hand.
       */
      const anonymousOnFailure = bearer === undefined;

      const session = await options.sessions.resolveToken(token);
      if (!session) {
        if (anonymousOnFailure) return undefined;
        throw new ZelavisAuthenticationError("Invalid or expired session.", {
          challenge: { scheme: "Bearer" },
        });
      }
      const account = await options.accounts.findById(session.accountId);
      if (!account) {
        if (anonymousOnFailure) return undefined;
        throw new ZelavisAuthenticationError("Session account no longer exists.", {
          challenge: { scheme: "Bearer" },
        });
      }
      return toPrincipal(
        account,
        session.id,
        bearer ? "bearer" : "cookie",
        options.projectId,
      );
    },
  };
}

export function createSessionCookie(
  token: string,
  options: {
    name?: string;
    path?: string;
    maxAgeSeconds?: number;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  } = {},
): string {
  if (options.sameSite === "None" && options.secure === false) {
    throw new TypeError('SameSite="None" session cookies must be Secure.');
  }
  const parts = [
    `${options.name ?? "zelavis_session"}=${encodeURIComponent(token)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.secure !== false) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join("; ");
}
