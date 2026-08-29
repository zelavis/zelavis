import type { AuthRepositories } from "../contracts/repositories.js";
import { AccountService } from "../services/account-service.js";
import { AuthenticationService } from "../services/authentication-service.js";
import { CredentialService } from "../services/credential-service.js";
import { SessionService } from "../services/session-service.js";
import { AuthSecurityService } from "../services/security-service.js";
import { createInMemoryAuthRepositories } from "../storage/in-memory.js";
import type { AuthApi, AuthMethodPlugin } from "./types.js";
import { createSessionAuthenticator } from "./session-authenticator.js";

export interface CreateAuthOptions {
  config?: Record<string, unknown>;
  methods?: readonly AuthMethodPlugin[];
  projectId?: string;
  sessionCookieName?: string | false;
  repositories?: Partial<AuthRepositories>;
  security?: {
    maxAttempts?: number;
    windowMs?: number;
    blockMs?: number;
  };
}

export async function createAuth(options: CreateAuthOptions = {}): Promise<AuthApi> {
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

  const api: AuthApi = {
    context: {
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
    await method.register(api);
  }

  return api;
}
