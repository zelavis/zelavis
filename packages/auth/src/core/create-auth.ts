import type { AuthRepositories } from "../contracts/repositories.js";
import { AccountService } from "../services/account-service.js";
import { AuthenticationService } from "../services/authentication-service.js";
import { CredentialService } from "../services/credential-service.js";
import { SessionService } from "../services/session-service.js";
import { createInMemoryAuthRepositories } from "../storage/in-memory.js";
import type { AuthPlugin } from "./define-auth-plugin.js";
import type { AuthApi } from "./types.js";

export interface CreateAuthOptions {
  config?: Record<string, unknown>;
  plugins?: AuthPlugin[];
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
    },
    repositories,
    accounts,
    credentials,
    sessions,
    authentication,
  };

  for (const plugin of options.plugins ?? []) {
    await plugin.setup(api);
  }

  return api;
}
