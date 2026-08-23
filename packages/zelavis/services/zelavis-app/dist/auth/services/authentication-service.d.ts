import type { AuthenticationInput, AuthenticationResult, CredentialProvider } from "../contracts/credential-provider.js";
import type { AccountService } from "./account-service.js";
import type { CredentialService } from "./credential-service.js";
import type { SessionService } from "./session-service.js";
export interface AuthenticationServiceOptions {
    accounts: AccountService;
    credentials: CredentialService;
    sessions: SessionService;
}
export declare class AuthenticationService {
    private readonly options;
    private readonly providers;
    constructor(options: AuthenticationServiceOptions);
    registerProvider(provider: CredentialProvider): CredentialProvider;
    getProvider(name: string): CredentialProvider | null;
    listProviders(): string[];
    authenticate(providerName: string, input: AuthenticationInput): Promise<AuthenticationResult>;
}
