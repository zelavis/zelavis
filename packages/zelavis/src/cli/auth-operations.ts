import { bodyFlag, integerFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";
import { decodeSetAccountAccessInput } from "../auth/access/access.js";
import { decodeRoleDefinitionInput } from "../auth/roles/catalogue.js";

/** `zelavis auth <group> <action>`: one command per Zelavis Auth operation, through `client.auth.<group>.<action>`. */
const groups = {
  "username-password": ["sign-up", "sign-in", "change-password"],
  "email-password": ["sign-up", "complete-sign-up", "sign-in", "change-password", "start-change-email", "complete-change-email", "start-recovery", "check-recovery", "complete-recovery"],
  "username-passkey": ["start-sign-up", "finish-sign-up", "start-sign-in", "start-autofill", "finish-sign-in"],
  passkeys: ["list", "start-add", "verify-add", "finish-add", "rename", "start-remove", "finish-remove", "settings", "set-settings"],
  oauth: ["providers", "start", "redeem", "connections", "configure", "remove"],
  mfa: ["status", "start-totp", "confirm-totp", "verify", "remove-totp", "regenerate-backup-codes", "policy", "set-policy"],
  emails: ["list", "start-add", "complete-add"],
  session: ["current", "refresh", "sign-out"],
  sessions: ["list", "revoke", "revoke-others"],
  keys: ["jwks", "rotate"],
  methods: ["list", "settings", "set-settings"],
  registration: ["status", "settings", "set-settings"],
  bootstrap: ["status", "claim"],
  admin: ["accounts", "create-account", "set-access", "import-accounts", "account-sessions", "revoke-account-session", "revoke-account-sessions", "reset-mfa", "security-events"],
} as const;

const invitationCommands = ["invitations", "invite", "resend-invitation", "revoke-invitation", "accept-invitation"];
const roleCommands = ["roles", "create-role", "update-role", "delete-role"];
const singleCommands = [...invitationCommands, ...roleCommands];

const usage = `zelavis auth <group> <action> [id...] [--data JSON] [--url URL] [--token TOKEN | --session-file PATH] [--json]
  ${Object.entries(groups).map(([group, actions]) => `${group}: ${actions.join("|")}`).join("\n  ")}
  zelavis auth <${invitationCommands.join("|")}> [id] [--limit N] [--after CURSOR] [--data JSON] [--json]
  zelavis auth <${roleCommands.join("|")}> [role] [--data JSON] [--revision N] [--json]
  service-accounts: zelavis auth service-accounts <list|create|rotate|revoke|set-tenant> …`;

const data = <A extends object>(input: CliInput, action: string) => bodyFlag<A>(input, "--data", `auth ${action}`);
const optionalData = <A extends object>(input: CliInput) => (input.flags.has("--data") ? bodyFlag<A>(input, "--data", "auth") : undefined);
const done = (key: string) => () => ({ [key]: true });

const table: CliTable = {
  name: "auth",
  usage,
  valued: ["--data", "--limit", "--after", "--account", "--session-file", "--revision"],
  actions: {
    invitations: { run: (input) => {
      const limit = integerFlag(input, "--limit");
      const after = input.flags.get("--after");
      return input.client.auth.admin.invitations({ ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) });
    } },
    invite: { run: (input) => input.client.auth.admin.invite(data(input, "invite")) },
    "resend-invitation": { run: (input) => input.client.auth.admin.resendInvitation(required(input, 0, "An invitation id")) },
    "revoke-invitation": { run: (input) => input.client.auth.admin.revokeInvitation(required(input, 0, "An invitation id")) },
    "accept-invitation": { run: (input) => input.client.auth.acceptInvitation(data(input, "accept-invitation")) },
    roles: { run: (input) => input.client.auth.admin.roles() },
    "create-role": { run: (input) => input.client.auth.admin.createRole(decodeRoleDefinitionInput(data(input, "create-role"))) },
    "update-role": {
      run: (input) => input.client.auth.admin.updateRole(required(input, 0, "A role id"), decodeRoleDefinitionInput(data(input, "update-role"))),
    },
    "delete-role": {
      run: (input) => {
        const revision = integerFlag(input, "--revision");
        if (revision === undefined) throw new Error("auth delete-role requires --revision N.");
        return input.client.auth.admin.deleteRole(required(input, 0, "A role id"), revision);
      },
    },
    "username-password sign-up": { run: (input) => input.client.auth.usernamePassword.signUp(data(input, "username-password sign-up")) },
    "username-password sign-in": { run: (input) => input.client.auth.usernamePassword.signIn(data(input, "username-password sign-in")) },
    "username-password change-password": { run: (input) => input.client.auth.usernamePassword.changePassword(data(input, "username-password change-password")) },
    "email-password sign-up": { run: (input) => input.client.auth.emailPassword.signUp(data(input, "email-password sign-up")) },
    "email-password complete-sign-up": { run: (input) => input.client.auth.emailPassword.completeSignUp(data(input, "email-password complete-sign-up")) },
    "email-password sign-in": { run: (input) => input.client.auth.emailPassword.signIn(data(input, "email-password sign-in")) },
    "email-password change-password": { run: (input) => input.client.auth.emailPassword.changePassword(data(input, "email-password change-password")) },
    "email-password start-change-email": { run: (input) => input.client.auth.emailPassword.startChangeEmail(data(input, "email-password start-change-email")) },
    "email-password complete-change-email": { run: (input) => input.client.auth.emailPassword.completeChangeEmail(data(input, "email-password complete-change-email")) },
    "email-password start-recovery": { run: (input) => input.client.auth.emailPassword.startRecovery(data(input, "email-password start-recovery")) },
    "email-password check-recovery": { run: (input) => input.client.auth.emailPassword.checkRecovery(data(input, "email-password check-recovery")) },
    "email-password complete-recovery": { run: (input) => input.client.auth.emailPassword.completeRecovery(data(input, "email-password complete-recovery")) },
    "username-passkey start-sign-up": { run: (input) => input.client.auth.usernamePasskey.startSignUp(data(input, "username-passkey start-sign-up")) },
    "username-passkey finish-sign-up": { run: (input) => input.client.auth.usernamePasskey.finishSignUp(data(input, "username-passkey finish-sign-up")) },
    "username-passkey start-sign-in": { run: (input) => input.client.auth.usernamePasskey.startSignIn(data(input, "username-passkey start-sign-in")) },
    "username-passkey start-autofill": { run: (input) => input.client.auth.usernamePasskey.startAutofill(optionalData(input)) },
    "username-passkey finish-sign-in": { run: (input) => input.client.auth.usernamePasskey.finishSignIn(data(input, "username-passkey finish-sign-in")) },
    "passkeys list": { run: (input) => input.client.auth.passkeys.list() },
    "passkeys start-add": { run: (input) => input.client.auth.passkeys.startAdd(optionalData(input)) },
    "passkeys verify-add": { run: (input) => input.client.auth.passkeys.verifyAdd(data(input, "passkeys verify-add")) },
    "passkeys finish-add": { run: (input) => input.client.auth.passkeys.finishAdd(data(input, "passkeys finish-add")) },
    "passkeys rename": { run: (input) => input.client.auth.passkeys.rename(required(input, 0, "A passkey id"), data(input, "passkeys rename")) },
    "passkeys start-remove": { run: (input) => input.client.auth.passkeys.startRemove(required(input, 0, "A passkey id"), optionalData(input)) },
    "passkeys finish-remove": { run: (input) => input.client.auth.passkeys.finishRemove(required(input, 0, "A passkey id"), data(input, "passkeys finish-remove")) },
    "passkeys settings": { run: (input) => input.client.auth.passkeys.settings() },
    "passkeys set-settings": { run: (input) => input.client.auth.passkeys.setSettings(data(input, "passkeys set-settings")) },
    "oauth providers": { run: (input) => input.client.auth.oauth.providers() },
    "oauth start": { run: (input) => {
      const { redirectTo } = data<{ redirectTo?: unknown }>(input, "oauth start");
      if (typeof redirectTo !== "string" || !redirectTo) throw new Error("OAuth start requires a redirectTo URL.");
      return input.client.auth.oauth.start(required(input, 0, "A provider"), { redirectTo });
    } },
    "oauth redeem": { run: (input) => input.client.auth.oauth.redeem(required(input, 0, "A provider"), data(input, "oauth redeem")) },
    "oauth connections": { run: (input) => input.client.auth.oauth.connections() },
    "oauth configure": { run: (input) => input.client.auth.oauth.configure(required(input, 0, "A provider"), data(input, "oauth configure")) },
    "oauth remove": { run: (input) => input.client.auth.oauth.remove(required(input, 0, "A provider")).then(done("removed")) },
    "mfa status": { run: (input) => input.client.auth.mfa.status() },
    "mfa start-totp": { run: (input) => input.client.auth.mfa.startTotp(optionalData(input)) },
    "mfa confirm-totp": { run: (input) => input.client.auth.mfa.confirmTotp(data(input, "mfa confirm-totp")) },
    "mfa verify": { run: (input) => input.client.auth.mfa.verify(data(input, "mfa verify")) },
    "mfa remove-totp": { run: (input) => input.client.auth.mfa.removeTotp(required(input, 0, "An authenticator id"), data(input, "mfa remove-totp")) },
    "mfa regenerate-backup-codes": { run: (input) => input.client.auth.mfa.regenerateBackupCodes(data(input, "mfa regenerate-backup-codes")) },
    "mfa policy": { run: (input) => input.client.auth.mfa.policy() },
    "mfa set-policy": { run: (input) => input.client.auth.mfa.setPolicy(data(input, "mfa set-policy")) },
    "emails list": { run: (input) => input.client.auth.emails.list() },
    "emails start-add": { run: (input) => input.client.auth.emails.startAdd(data(input, "emails start-add")) },
    "emails complete-add": { run: (input) => input.client.auth.emails.completeAdd(data(input, "emails complete-add")) },
    "session current": { run: (input) => input.client.auth.session.current() },
    "session refresh": { run: (input) => input.client.auth.session.refresh(optionalData(input)) },
    "session sign-out": { run: (input) => input.client.auth.session.signOut(optionalData(input)).then(done("signedOut")) },
    "sessions list": { run: (input) => input.client.auth.sessions.list() },
    "sessions revoke": { run: (input) => input.client.auth.sessions.revoke(required(input, 0, "A session id")).then(done("revoked")) },
    "sessions revoke-others": { run: (input) => input.client.auth.sessions.revokeOthers() },
    "keys jwks": { run: (input) => input.client.auth.keys.jwks() },
    "keys rotate": { run: (input) => input.client.auth.keys.rotate() },
    "methods list": { run: (input) => input.client.auth.methods.list() },
    "methods settings": { run: (input) => input.client.auth.methods.settings() },
    "methods set-settings": { run: (input) => input.client.auth.methods.setSettings(data(input, "methods set-settings")) },
    "registration status": { run: (input) => input.client.auth.registration.status() },
    "registration settings": { run: (input) => input.client.auth.registration.settings() },
    "registration set-settings": { run: (input) => input.client.auth.registration.setSettings(data(input, "registration set-settings")) },
    "bootstrap status": { run: (input) => input.client.auth.bootstrap.status() },
    "bootstrap claim": { run: (input) => input.client.auth.bootstrap.claim(data(input, "bootstrap claim")) },
    "admin accounts": {
      run: (input) => input.client.auth.admin.accounts({
        ...(input.flags.has("--account") ? { accountId: input.flags.get("--account")! } : {}),
        ...(integerFlag(input, "--limit") === undefined ? {} : { limit: integerFlag(input, "--limit")! }),
        ...(input.flags.has("--after") ? { after: input.flags.get("--after")! } : {}),
      }),
    },
    "admin create-account": { run: (input) => input.client.auth.admin.createAccount(data(input, "admin create-account")) },
    "admin set-access": {
      run: (input) => input.client.auth.admin.setAccess(required(input, 0, "An account id"), decodeSetAccountAccessInput(data(input, "admin set-access"))),
    },
    "admin import-accounts": { run: (input) => input.client.auth.admin.importAccounts(data(input, "admin import-accounts")) },
    "admin account-sessions": { run: (input) => input.client.auth.admin.accountSessions(required(input, 0, "An account id")) },
    "admin revoke-account-session": {
      run: (input) => input.client.auth.admin.revokeAccountSession(required(input, 0, "An account id"), required(input, 1, "A session id")).then(done("revoked")),
    },
    "admin revoke-account-sessions": { run: (input) => input.client.auth.admin.revokeAccountSessions(required(input, 0, "An account id")) },
    "admin reset-mfa": { run: (input) => input.client.auth.admin.resetMfa(required(input, 0, "An account id")) },
    "admin security-events": {
      run: (input) => input.client.auth.admin.securityEvents({
        ...(input.flags.has("--account") ? { accountId: input.flags.get("--account")! } : {}),
        ...(integerFlag(input, "--limit") === undefined ? {} : { limit: integerFlag(input, "--limit")! }),
        ...(input.flags.has("--after") ? { after: input.flags.get("--after")! } : {}),
      }),
    },
  },
};

/** The rest of `zelavis auth`, through the SDK client's `auth`; service accounts keep their own commands. */
export function runAuthOperations(args: readonly string[]): Promise<void> {
  // The group and its action are the first two arguments; the table names them together.
  const [group, action, ...rest] = args;
  const known = group !== undefined && !singleCommands.includes(group) && action !== undefined && !action.startsWith("-");
  return runTable(table, known ? [`${group} ${action}`, ...rest] : args);
}
