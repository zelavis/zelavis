/**
 * Zelavis Auth (`zelavis/auth`). See `upstream.json` for derived-file provenance.
 */
export * from "./accounts/accounts.js";
export { accountsTables, type Account } from "./accounts/tables.js";
export { accountSessionPrincipal } from "./accounts/principal.js";
export * from "./core/authenticator.js";
export * from "./core/context.js";
export * from "./core/cookies.js";
export type { AuthFailure, AuthStartupFailure } from "./core/errors.js";
export * from "./core/setup.js";
export { getAuthUserId } from "./core/userId.js";
export { coreTables } from "./core/tables.js";
export * from "./create-auth.js";
export { type AuthKeysAdmin, type AccessTokenCheck, AUDIENCE, createAuthKeys } from "./keys/keys.js";
export { keysTables } from "./keys/tables.js";
export * from "./lib/ttl.js";
export * from "./lib/types.js";
export { defineAuthCoreRoutes } from "./routes/core.js";
export * from "./runtime/index.js";
export { type EmailPasswordMethod, setupEmailPassword } from "./methods/email-password.js";
export { emailTables } from "./email/tables.js";
export * from "./access/access.js";
export * from "./access/delegation.js";
export { RegistrationClosed, RegistrationRateLimited, type RegistrationRefused } from "./registration/errors.js";
export * from "./registration/policy.js";
export { registrationTables } from "./registration/tables.js";
export { bootstrapRequired, createBootstrap, type Bootstrap } from "./bootstrap/bootstrap.js";
export { bootstrapTables } from "./bootstrap/tables.js";
export * from "./security/events.js";
export { securityTables } from "./security/tables.js";
export * from "./serviceAccounts/tokens.js";
export { serviceAccountTables } from "./serviceAccounts/tables.js";
export * from "./methods/catalogue.js";
export { defineAdminRoutes } from "./routes/admin.js";
export { projectDatabaseIdentitySource, systemStoreIdentitySource, type IdentitySource } from "./import/sources.js";
export { defineOAuthProviders, OAUTH_PROVIDER_CAPABILITY, type OAuthProviderDefinition } from "./oauth/plugins.js";
