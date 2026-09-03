import type { AuthRepositories } from "../contracts/repositories.js";
import type { AccountService } from "../services/account-service.js";
import type { AuthenticationService } from "../services/authentication-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { SessionService } from "../services/session-service.js";
import type { AuthSecurityService } from "../services/security-service.js";
import type { ZelavisRequestAuthenticator } from "../../../core/index.js";
import type { Account, IssuedSession } from "../domain/entities.js";
import type { CredentialEnrollmentInput } from "../contracts/credential-provider.js";

/**
 * What a credential provider plugin is given when it registers.
 *
 * Registration happens while auth is being created, which is before services
 * are set up — so a plugin that hosts other plugins' providers had no way to
 * see them, and no way to read the configuration an operator saved. Both
 * arrive here instead.
 */
export interface AuthMethodContext {
  /** The installed services, for a plugin that discovers others by capability. */
  registry: readonly {
    status: string;
    service: { name: string; capabilities?: readonly string[]; service?: unknown };
  }[];
  /** Durable storage scoped to the registering service, when the host has one. */
  store?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(): Promise<readonly { key: string; value: unknown }[]>;
  };
}

export interface AuthMethodPlugin {
  name: string;
  register: (api: AuthApi, context?: AuthMethodContext) => void | Promise<void>;
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
  security: AuthSecurityService;
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
