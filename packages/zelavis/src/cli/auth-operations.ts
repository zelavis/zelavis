import { bodyFlag, required, runTable, type CliTable } from "./command-table.js";

const usage =
  "zelavis auth <providers|oauth-providers|sign-up|sign-in|session|refresh|sign-out|sessions|revoke-session|recovery-providers|recover|complete-recovery|accounts|create-account|create-credentials|account-sessions|revoke-account-sessions|revoke-account-session|security-events|oauth-connections|configure-oauth|remove-oauth|oauth-start|link-start|bootstrap-status|bootstrap> [provider|id] [--data JSON] [--url URL] [--token TOKEN] [--json]   (service accounts: zelavis auth service-accounts …)";

const table: CliTable = {
  name: "auth",
  usage,
  valued: ["--data"],
  actions: {
    providers: { run: (input) => input.client.auth.providers() },
    "oauth-providers": { run: (input) => input.client.auth.oauthProviders() },
    "sign-up": { run: (input) => input.client.auth.signUp(required(input, 0, "A provider") as string, bodyFlag(input, "--data", "auth sign-up") as { identifier: string }) },
    "sign-in": { run: (input) => input.client.auth.signIn(required(input, 0, "A provider"), bodyFlag(input, "--data", "auth sign-in") as { identifier: string }) },
    session: { run: (input) => input.client.auth.getSession() },
    refresh: { run: (input) => input.client.auth.refreshSession() },
    "sign-out": { run: (input) => input.client.auth.signOut().then(() => ({ signedOut: true })) },
    sessions: { run: (input) => input.client.auth.sessions() },
    "revoke-session": { run: (input) => input.client.auth.revokeSession(required(input, 0, "A session id")).then(() => ({ revoked: true })) },
    "recovery-providers": { run: (input) => input.client.auth.recoveryProviders() },
    recover: { run: (input) => input.client.auth.beginRecovery(required(input, 0, "A provider"), bodyFlag(input, "--data", "auth recover")) },
    "complete-recovery": { run: (input) => input.client.auth.completeRecovery(required(input, 0, "A provider"), bodyFlag(input, "--data", "auth complete-recovery")).then(() => ({ recovered: true })) },
    accounts: { run: (input) => input.client.auth.admin.accounts() },
    "create-account": { run: (input) => input.client.auth.admin.createAccount(bodyFlag(input, "--data", "auth create-account")) },
    "create-credentials": { run: (input) => input.client.auth.admin.createCredentials(bodyFlag(input, "--data", "auth create-credentials")) },
    "account-sessions": { run: (input) => input.client.auth.admin.accountSessions(required(input, 0, "An account id")) },
    "revoke-account-sessions": { run: (input) => input.client.auth.admin.revokeAccountSessions(required(input, 0, "An account id")) },
    "revoke-account-session": { run: (input) => input.client.auth.admin.revokeAccountSession(required(input, 0, "An account id"), required(input, 1, "A session id")) },
    "security-events": { run: (input) => input.client.auth.admin.securityEvents() },
    "oauth-connections": { run: (input) => input.client.auth.admin.oauthConnections() },
    "configure-oauth": { run: (input) => input.client.auth.admin.configureOAuth(required(input, 0, "A provider"), bodyFlag(input, "--data", "auth configure-oauth") as never) },
    "remove-oauth": { run: (input) => input.client.auth.admin.removeOAuth(required(input, 0, "A provider")).then(() => ({ removed: true })) },
    "oauth-start": { run: (input) => input.client.auth.signInWithOAuth(required(input, 0, "A provider")) },
    "link-start": { run: (input) => input.client.auth.linkIdentity(required(input, 0, "A provider")) },
    "bootstrap-status": { run: (input) => input.client.auth.bootstrapStatus() },
    bootstrap: { run: (input) => input.client.auth.bootstrap(bodyFlag(input, "--data", "auth bootstrap")) },
  },
};

/** The rest of `zelavis auth`, through the SDK client's `auth`; service accounts keep their own commands. */
export function runAuthOperations(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
