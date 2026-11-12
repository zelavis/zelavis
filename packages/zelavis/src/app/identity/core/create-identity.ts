import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import { RegistrationError } from "./errors.js";
import type { IdentityRepositories } from "../contracts/repositories.js";
import { AccountService } from "../services/account-service.js";
import { AuthenticationService } from "../services/authentication-service.js";
import { CredentialService } from "../services/credential-service.js";
import type { RegistrationServiceOptions } from "../domain/registration.js";
import { RegistrationService, type RegistrationRecovery } from "../services/registration-service.js";
import { SessionService } from "../services/session-service.js";
import { AuthSecurityService } from "../services/security-service.js";
import { createInMemoryAuthRepositories } from "../storage/in-memory.js";
import type { IdentityApi, IdentityMethodContext, IdentityMethodPlugin } from "./types.js";
import { createSessionAuthenticator } from "./session-authenticator.js";
import { projectSessionAudience, projectSessionCookieName, projectSessionTokenPrefix } from "./project-session-audience.js";

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
  /** Custom account or credential stores also need their own conditional registration repository. */
  repositories?: Partial<IdentityRepositories>;
  /** Stable writer identity across recompositions that share one account store. */
  accountAccessWriter?: object;
  registration?: Partial<RegistrationServiceOptions>;
  registrationRecovery?: RegistrationRecovery;
  security?: {
    maxAttempts?: number;
    windowMs?: number;
    blockMs?: number;
  };
}

export function createIdentity(options: CreateIdentityOptions = {}): Promise<IdentityApi> {
  return present(Effect.gen(function* (): Effect.fn.Return<IdentityApi, IntegrationFailure> {
    const overrides = options.repositories;
    const missingRegistration = (overrides?.accounts || overrides?.credentials) && !overrides.registration;
    const unavailable = () => present(Effect.fail(
      new RegistrationError("RegistrationUnavailable", "Registration is temporarily unavailable."),
    ));
    const repositories = createInMemoryAuthRepositories(missingRegistration
      ? { ...overrides, registration: { read: unavailable, mutate: unavailable } }
      : overrides);

    const accounts = new AccountService(repositories.accounts, repositories.securityEvents, options.accountAccessWriter);
    const credentials = new CredentialService(repositories.credentials);
    const audience = options.projectId === undefined ? undefined : yield* integrationValue(projectSessionAudience(options.projectId));
    const cookieName = options.sessionCookieName ?? (audience === undefined ? undefined : projectSessionCookieName(audience));
    const sessions = new SessionService(repositories.sessions, repositories.accounts,
      audience === undefined ? undefined : projectSessionTokenPrefix(audience));
    const registration = new RegistrationService(
      repositories,
      accounts,
      credentials,
      sessions,
      () => authentication.listProviders().flatMap((name) => {
        const provider = authentication.getProvider(name);
        return provider ? [provider] : [];
      }),
      {
        authority: options.registration?.authority ?? "project",
        initiallyEnabled: options.registration?.initiallyEnabled ?? false,
        enrollmentReady: options.registration?.enrollmentReady ??
          (() => present(Effect.succeed(options.registration?.authority !== "platform"))),
        now: options.registration?.now ?? (() => new Date()),
      },
      options.registrationRecovery,
    );
    const authentication: AuthenticationService = new AuthenticationService({
      accounts,
      credentials,
      sessions,
      authorizationFlows: repositories.authorizationFlows,
      registration,
    });
    const security = new AuthSecurityService({
      attempts: repositories.attempts,
      events: repositories.securityEvents,
      ...options.security,
    });

    const api: IdentityApi = {
      context: {
        projectId: options.projectId,
        sessionCookieName: cookieName,
        config: options.config ?? {},
        methods: Object.freeze([...(options.methods ?? [])]),
      },
      repositories,
      accounts,
      credentials,
      sessions,
      authentication,
      security,
      registration,
      requestAuthenticator: createSessionAuthenticator({
        accounts,
        sessions,
        projectId: options.projectId,
        cookieName,
      }),
    };

    yield* integrationValue(registration.initialize());

    for (const method of options.methods ?? []) {
      (yield* integrationValue(method.register(api, options.methodContext?.(method))));
    }

    return api;
  }));
}
