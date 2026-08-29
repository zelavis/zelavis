import type { AuthRepositories } from "../contracts/repositories.js";
import type { AccountService } from "../services/account-service.js";
import type { AuthenticationService } from "../services/authentication-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { SessionService } from "../services/session-service.js";
import type { ZelavisRequestAuthenticator } from "../../../core/index.js";
import type { Account, IssuedSession } from "../domain/entities.js";
import type { CredentialEnrollmentInput } from "../contracts/credential-provider.js";

export interface AuthMethodPlugin {
  name: string;
  register: (api: AuthApi) => void | Promise<void>;
}

export interface AuthContext {
  config: Record<string, unknown>;
  methods: readonly AuthMethodPlugin[];
}

export interface AuthApi {
  context: AuthContext;
  repositories: AuthRepositories;
  accounts: AccountService;
  credentials: CredentialService;
  sessions: SessionService;
  authentication: AuthenticationService;
  requestAuthenticator: ZelavisRequestAuthenticator;
}

export interface AuthBootstrapStatus {
  required: boolean;
  providers: readonly string[];
  enrollmentProviders: readonly string[];
}

export interface AuthBootstrapInput {
  provider: string;
  account: {
    email?: string;
    username?: string;
    displayName?: string;
  };
  credential: CredentialEnrollmentInput;
}

export interface AuthBootstrapResult {
  account: Account;
  session: IssuedSession;
}

export interface AuthBootstrapCapability {
  status(): Promise<AuthBootstrapStatus>;
  bootstrap(input: AuthBootstrapInput): Promise<AuthBootstrapResult>;
}
