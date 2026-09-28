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

export async function createIdentity(options: CreateIdentityOptions = {}): Promise<IdentityApi> {
  const repositories = createInMemoryAuthRepositories(options.repositories);
  const accounts = new AccountService(repositories.accounts);
  const credentials = new CredentialService(repositories.credentials);
  const sessions = new SessionService(repositories.sessions);
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
    await method.register(api, options.methodContext?.(method));
  }

  return api;
}
