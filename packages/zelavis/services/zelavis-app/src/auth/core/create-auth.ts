import type { AuthRepositories } from "../contracts/repositories.js";
import { AccountService } from "../services/account-service.js";
import { AuthenticationService } from "../services/authentication-service.js";
import { CredentialService } from "../services/credential-service.js";
import { SessionService } from "../services/session-service.js";
import { createInMemoryAuthRepositories } from "../storage/in-memory.js";
import type { AuthApi, AuthProviderService } from "./types.js";

export interface CreateAuthOptions {
  config?: Record<string, unknown>;
  services?: readonly AuthProviderService[];
  repositories?: Partial<AuthRepositories>;
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
  });

  const api: AuthApi = {
    context: {
      config: options.config ?? {},
      childServices: Object.freeze([...(options.services ?? [])]),
    },
    repositories,
    accounts,
    credentials,
    sessions,
    authentication,
  };

  for (const service of options.services ?? []) {
    await service.setup?.(api);
  }

  return api;
}
