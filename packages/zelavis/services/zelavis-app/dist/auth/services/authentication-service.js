import { AuthNotFoundError, AuthValidationError } from "../core/errors.js";
export class AuthenticationService {
    options;
    providers = new Map();
    constructor(options) {
        this.options = options;
    }
    registerProvider(provider) {
        if (!provider.name) {
            throw new AuthValidationError("Credential provider registration requires a name.");
        }
        this.providers.set(provider.name, provider);
        return provider;
    }
    getProvider(name) {
        return this.providers.get(name) ?? null;
    }
    listProviders() {
        return Array.from(this.providers.keys());
    }
    async authenticate(providerName, input) {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new AuthNotFoundError(`Unknown authentication provider: ${providerName}`);
        }
        const api = {
            accounts: {
                findById: (id) => this.options.accounts.findById(id),
                findByEmail: (email) => this.options.accounts.findByEmail(email),
                findByUsername: (username) => this.options.accounts.findByUsername(username),
            },
            credentials: {
                findByProviderIdentifier: (registeredProvider, identifier) => this.options.credentials.findByProviderIdentifier(registeredProvider, identifier),
            },
            sessions: {
                create: (session) => this.options.sessions.create(session),
            },
        };
        return provider.authenticate(input, api);
    }
}
