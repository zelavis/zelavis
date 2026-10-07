import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import type { IdentityRepositories } from "../contracts/repositories.js";
import { AccountService } from "../services/account-service.js";
import { AuthenticationService } from "../services/authentication-service.js";
import { CredentialService } from "../services/credential-service.js";
import { SessionService } from "../services/session-service.js";
import { AuthSecurityService } from "../services/security-service.js";
import { createInMemoryAuthRepositories } from "../storage/in-memory.js";
import type { IdentityApi, IdentityMethodContext, IdentityMethodPlugin } from "./types.js";
import { createSessionAuthenticator } from "./session-authenticator.js";

export interface CreateIdentityOptions {
  config?: Record<string, unknown>;
  methods?: readonly IdentityMethodPlugin[];
  /**
   * Builds the context a method receives when it registers.
   *
   * Supplied by whoever composed auth, because a method's registry view and
   * its storage namespace are the host's to decide, not the plugin's.
   */
  methodContext?: (method: IdentityMethodPlugin) => IdentityMethodContext | undefined;
  projectId?: string;
  sessionCookieName?: string | false;
  repositories?: Partial<IdentityRepositories>;
  security?: {
    maxAttempts?: number;
    windowMs?: number;
    blockMs?: number;
  };
}

export function createIdentity(options: CreateIdentityOptions = {}): Promise<IdentityApi> {
    return present(Effect.gen(function* (): Effect.fn.Return<IdentityApi, IntegrationFailure> {
  const repositories = createInMemoryAuthRepositories(options.repositories);
  const accounts = new AccountService(repositories.accounts);
  const credentials = new CredentialService(repositories.credentials);
  const sessions = new SessionService(repositories.sessions, repositories.accounts);
  const authentication = new AuthenticationService({
    accounts,
    credentials,
    sessions,
    authorizationFlows: repositories.authorizationFlows,
  });
  const security = new AuthSecurityService({
    attempts: repositories.attempts,
    events: repositories.securityEvents,
    ...options.security,
  });

  const api: IdentityApi = {
    context: {
      projectId: options.projectId,
      config: options.config ?? {},
      methods: Object.freeze([...(options.methods ?? [])]),
    },
    repositories,
    accounts,
    credentials,
    sessions,
    authentication,
    security,
    requestAuthenticator: createSessionAuthenticator({
      accounts,
      sessions,
      projectId: options.projectId,
      cookieName: options.sessionCookieName,
    }),
  };

  for (const method of options.methods ?? []) {
    (yield* integrationValue(method.register(api, options.methodContext?.(method))));
  }

  return api;
}));
  }
