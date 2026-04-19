import type { AuthRepositories } from "../contracts/repositories.js";
import type { AccountService } from "../services/account-service.js";
import type { AuthenticationService } from "../services/authentication-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { SessionService } from "../services/session-service.js";

export interface AuthContext {
  config: Record<string, unknown>;
}

export interface AuthApi {
  context: AuthContext;
  repositories: AuthRepositories;
  accounts: AccountService;
  credentials: CredentialService;
  sessions: SessionService;
  authentication: AuthenticationService;
}
