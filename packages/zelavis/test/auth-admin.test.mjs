/**
 * Zelavis Auth, account administration (part 11): access and delegation, the registration policy, administrator
 * creation, listing and sessions, the MFA reset, import, security events and the methods catalogue, over HTTP.
 *
 * Ported from `test/identity-account-access.test.mjs`, `test/identity-registration.test.mjs` and
 * `test/auth-account-import.test.mjs` (the cases about behavior). Not ported, because Auth has no such state:
 * Identity's enrollment slots and their recovery (`disable orders before an outstanding signup commit…`,
 * `a committed slot stays committed…`, `failed compensation stays recoverable…`, `seeded enrollment transitions…`,
 * `in-process recomposition leaves a live enrollment…`), the administration semaphores (`queued access edits …
 * bound admission`), the repository matrix (one engine now) and Identity's custom-store and provider-input cases.
 * The SDK and CLI forms of import arrive with the cut-over (part 13).
 */
import assert from "node:assert/strict";
import { pbkdf2Sync, scryptSync } from "node:crypto";
import test from "node:test";
import { resolveActor } from "../dist/auth/access/delegation.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { portablePasswordHash } from "../dist/auth/admin/import.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { emailTables } from "../dist/auth/email/tables.js";
import { passwordTables } from "../dist/auth/password/tables.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { SECURITY_EVENT_RETENTION_MS, createSecurityRetentionSweep } from "../dist/auth/security/events.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { confirmTotp, createTotp } from "../dist/auth/totp/enrollment.js";
import { totpKey } from "../dist/auth/totp/helpers.js";
import { totpTables } from "../dist/auth/totp/tables.js";
import { totp } from "../dist/auth/totp/totp.js";
import { usernameTables } from "../dist/auth/username/tables.js";
import { bindTestMethod, composeAuth, expectStatus, recordingOutbox, TEST_MASTER_SECRET } from "./_auth.mjs";

const TOKEN = "zelavis-bootstrap-token-of-at-least-32-chars";
const PASSWORD = "correct horse battery staple";
const grant = (permission, projectId = "first-app") => ({ permission, scope: { type: "project", projectId } });
const change = (overrides) => ({ role: "customer", expectedRevision: 0, permissions: [], grants: [], roleAssignments: [], ...overrides });

/** A Platform with its owner signed in; `create` makes an account through the admin route, `signIn` signs one in. */
async function platform(t, options = {}) {
  const a = await composeAuth(t, { bootstrapped: false, bootstrapToken: TOKEN, ...options });
  const owner = await expectStatus(await a.call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD } }), 201);
  const as = (tokens) => ({ headers: a.bearer(tokens) });
  const send = (path, method, body, by = owner.tokens) => a.call(path, { method, body, ...as(by) });
  const create = async (username, role, by = owner.tokens) =>
    (await expectStatus(await send("accounts", "POST", { username, password: PASSWORD, ...(role === undefined ? {} : { role }) }, by), 201)).account;
  const signIn = async (username) =>
    (await expectStatus(await a.call("username-password/sign-in", { method: "POST", body: { username, password: PASSWORD } }), 200)).tokens;
  const setAccess = (accountId, input, by = owner.tokens) => send(`accounts/${accountId}/access`, "PUT", input, by);
  return { ...a, owner, send, create, signIn, setAccess };
}

const eventsOf = async (a) => (await a.rows(securityTables.events)).map((event) => event.kind);

test("account access changes only once per revision and ends the account's sessions", async (t) => {
  const a = await platform(t);
  const target = await a.create("target");
  const initial = await a.signIn("target");
  assert.equal((await expectStatus(await a.setAccess(target.id, change()), 200)).accessRevision, 0, "an edit that changes nothing keeps the revision");
  await expectStatus(await a.call("session", { headers: a.bearer(initial) }), 200);

  const changes = [
    change({ grants: [grant("project.view", "second-app"), grant("project.view"), grant("project.view")] }),
    change({ grants: [grant("project.logs.read")] }),
  ];
  const settled = await Promise.all(changes.map((input) => a.setAccess(target.id, input)));
  const winner = settled.findIndex((response) => response.status === 200);
  assert.notEqual(winner, -1);
  const committed = await expectStatus(settled[winner], 200);
  assert.equal((await expectStatus(settled[1 - winner], 409)).code, "account_access_conflict");
  assert.equal(committed.accessRevision, 1);
  assert.deepEqual(committed.grants, winner === 0 ? [grant("project.view"), grant("project.view", "second-app")] : [grant("project.logs.read")]);
  assert.equal((await expectStatus(await a.call("session", { headers: a.bearer(initial) }), 401)).code, "not_signed_in", "the change ended the old session");
  const renewed = await a.signIn("target");
  assert.deepEqual(await expectStatus(await a.setAccess(target.id, { ...changes[winner], expectedRevision: 1 }), 200), committed);
  await expectStatus(await a.call("session", { headers: a.bearer(renewed) }), 200);
  assert.equal((await expectStatus(await a.setAccess(target.id, changes[winner]), 409)).code, "account_access_conflict");
  assert.ok((await eventsOf(a)).includes("account.access.changed"));
});

test("access edits recheck the administrator's authority and protect privileged identities", async (t) => {
  const a = await platform(t);
  const operator = await a.create("operator", "operator");
  await expectStatus(await a.setAccess(operator.id, change({ role: "operator", permissions: ["system.users.manage"], grants: [grant("project.view")] })), 200);
  const target = await a.create("target");
  const delegate = await a.signIn("operator");

  for (const input of [
    change({ grants: [grant("project.view", "second-app")] }),
    change({ permissions: ["project.view"] }),
    change({ role: "reseller" }),
  ]) {
    assert.equal((await expectStatus(await a.setAccess(target.id, input, delegate), 403)).code, "account_access_forbidden");
  }
  assert.equal((await expectStatus(await a.setAccess(a.owner.userId, change(), a.owner.tokens), 403)).code, "account_access_forbidden", "nobody edits their own access");
  assert.equal((await expectStatus(await a.setAccess(a.owner.userId, change(), delegate), 403)).code, "account_access_forbidden", "the owner is protected");
  assert.equal((await expectStatus(await a.setAccess("0".repeat(32), change()), 404)).code, "account_not_found");
  assert.equal((await expectStatus(await a.setAccess(target.id, change({ grants: [grant("project.view")] }), delegate), 200)).accessRevision, 1);

  // A principal resolved before the operator loses its authority (a request already past the route check):
  const stale = await a.run(a.auth.authenticate(new Request("https://auth.example.test/", { headers: a.bearer(delegate) })));
  assert.equal(stale.id, operator.id);
  // The owner takes the operator's authority away; the operator's next edit is refused although its token is fresh.
  const demoted = await a.setAccess(operator.id, change({ role: "operator", expectedRevision: 1 }));
  assert.equal(demoted.status, 200);
  // ...is refused inside the transaction that would write, which reads the operator's account as it is now.
  assert.equal(await a.run(a.core.query({ ip: null }, (tx) => resolveActor(tx, stale, { authority: "platform" }))), null);
  const again = await a.signIn("operator");
  assert.equal((await a.setAccess(target.id, change({ expectedRevision: 1 }), again)).status, 403, "the route refuses an operator without system.users.manage");
  const [stored] = (await a.rows(accountsTables.accounts)).filter((account) => account._id === target.id);
  assert.deepEqual(stored.grants, [grant("project.view")]);
});

test("strict input rejects wildcards, template scope and excess entries", async (t) => {
  const a = await platform(t);
  const target = await a.create("target");
  for (const input of [
    change({ unexpected: true }),
    change({ expectedRevision: Number.MAX_SAFE_INTEGER + 1 }),
    change({ permissions: ["*"] }),
    change({ grants: [{ permission: "project.view", scope: { type: "project", projectIdParam: "projectId" } }] }),
    change({ grants: [{ permission: "project.view", scope: { type: "project", projectId: "a", projectIdParam: "projectId" } }] }),
    change({ permissions: Array(100).fill("project.view"), grants: [grant("project.view")] }),
  ]) {
    assert.equal((await expectStatus(await a.setAccess(target.id, input), 400)).code, "invalid_account_access");
  }
  assert.equal((await expectStatus(await a.setAccess(target.id, change({ role: "user" })), 403)).code, "account_access_forbidden", "the Platform never gives the App role");
});

test("a Project administrator delegates only grants it holds, for its own Project", async (t) => {
  const a = await composeAuth(t, { role: "project", projectId: "first-app" });
  const method = bindTestMethod(a.auth);
  const adminTokens = await a.run(method.signUp({}));
  const targetTokens = await a.run(method.signUp({}));
  // The test grants the administrator its authority directly; on a real App it comes from the Gateway or an edit.
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, adminTokens.userId, {
    grants: [grant("project.users.manage"), grant("database.read")],
  })));
  const edit = (input, by = adminTokens) => a.call(`accounts/${targetTokens.userId}/access`, { method: "PUT", body: input, headers: a.bearer(by) });
  for (const input of [
    change({ role: "customer" }),
    change({ role: "user", permissions: ["database.read"] }),
    change({ role: "user", grants: [grant("database.read", "second-app")] }),
    change({ role: "user", grants: [grant("database.write")] }),
    change({ role: "user", grants: [{ permission: "database.read", scope: { type: "system" } }] }),
  ]) {
    assert.equal((await expectStatus(await edit(input), 403)).code, "account_access_forbidden", JSON.stringify(input));
  }
  const allowed = change({ role: "user", grants: [grant("database.read")] });
  assert.deepEqual((await expectStatus(await edit(allowed), 200)).grants, allowed.grants);
  const otherTokens = await a.run(method.signUp({}));
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, otherTokens.userId, { grants: [grant("project.users.manage")] })));
  assert.equal((await expectStatus(await edit(change({ role: "user", expectedRevision: 1 }), otherTokens), 403)).code, "account_access_forbidden",
    "an administrator who lacks the target's database.read cannot manage it");
});

test("with registration closed every method's sign-up answers 403 and writes nothing", async (t) => {
  const outbox = recordingOutbox();
  const a = await composeAuth(t, { registration: false, emailOutbox: outbox, passkeys: { publicOrigins: ["https://auth.example.test"] } });
  const method = bindTestMethod(a.auth);
  const before = async () => Promise.all([accountsTables.accounts, usernameTables.usernames, passwordTables.passwords, coreTables.sessions].map(async (table) => (await a.rows(table)).length));
  const empty = await before();
  const attempts = [
    ["username-password/sign-up", { username: "someone", password: PASSWORD }],
    ["email-password/sign-up", { email: "someone@example.test", password: PASSWORD }],
    ["username-passkey/sign-up/start", { username: "someone" }],
  ];
  for (const [path, body] of attempts) {
    assert.equal((await expectStatus(await a.call(path, { method: "POST", body }), 403)).code, "registration_closed", path);
  }
  // Every other method (OAuth among them) signs up through the core's completeSignUp, which the same gate admits.
  await assert.rejects(a.run(method.signUp({})), { _tag: "RegistrationClosed" });
  assert.deepEqual(await before(), empty);
  assert.equal(outbox.delivered.length, 0);
  assert.equal((await a.rows({ collection: "passkey_challenges", ...(await import("../dist/auth/passkey/tables.js")).passkeyTables.challenges })).length, 0);
  assert.deepEqual(await expectStatus(await a.call("registration"), 200), { enabled: false, providers: [] });
});

test("registration settings change once per revision, and open registration admits sign-ups within its limits", async (t) => {
  const a = await platform(t, { registration: false });
  const body = { username: "newcomer", password: PASSWORD };
  assert.equal((await expectStatus(await a.call("username-password/sign-up", { method: "POST", body }), 403)).code, "registration_closed");
  assert.deepEqual(await expectStatus(await a.send("registration/settings", "GET"), 200), { enabled: false, revision: 0 });
  assert.equal((await a.call("registration/settings", { method: "PUT", body: { enabled: true, expectedRevision: 0 } })).status, 401, "settings need the settings permission");
  assert.deepEqual(await expectStatus(await a.send("registration/settings", "PUT", { enabled: true, expectedRevision: 0 }), 200), { enabled: true, revision: 1 });
  const stale = await expectStatus(await a.send("registration/settings", "PUT", { enabled: false, expectedRevision: 0 }), 409);
  assert.equal(stale.code, "registration_settings_conflict");
  assert.deepEqual(stale.current, { enabled: true, revision: 1 });
  assert.equal((await expectStatus(await a.send("registration/settings", "PUT", { enabled: true, expectedRevision: 0, emailVerification: "required" }), 400)).code, "invalid_registration");
  const status = await expectStatus(await a.call("registration"), 200);
  assert.equal(status.enabled, true);
  assert.ok(status.providers.includes("usernamePassword"));
  const created = await expectStatus(await a.call("username-password/sign-up", { method: "POST", body }), 200);
  const [account] = (await a.rows(accountsTables.accounts)).filter((row) => row._id === created.userId);
  assert.deepEqual(account.roles, ["customer"]);

  // Ten sign-ups an hour per client address: the eleventh is refused, another client is not.
  for (let i = 1; i < 10; i += 1) await expectStatus(await a.call("username-password/sign-up", { method: "POST", body: { username: `user${i}`, password: PASSWORD } }), 200);
  const limited = await a.call("username-password/sign-up", { method: "POST", body: { username: "user10", password: PASSWORD } });
  assert.equal((await expectStatus(limited, 429)).code, "registration_rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  a.client.address = "198.51.100.8";
  await expectStatus(await a.call("username-password/sign-up", { method: "POST", body: { username: "user10", password: PASSWORD } }), 200);
  assert.ok((await eventsOf(a)).includes("registration.settings.changed"));
});

test("registration and method settings recheck the actor inside the write", async (t) => {
  const a = await platform(t, { registration: false });
  const operator = await a.create("staff", "operator");
  await expectStatus(await a.setAccess(operator.id, change({ role: "operator", permissions: ["system.settings.manage"] })), 200);
  const tokens = await a.signIn("staff");
  const request = new Request("https://auth.example.test/auth/methods/settings", { method: "PUT", headers: a.bearer(tokens) });
  const principal = await a.run(a.auth.authenticate(request));
  assert.deepEqual(principal.permissions, ["system.settings.manage"]);

  // Simulate a request that already passed dispatch when the administrator lost access.
  await expectStatus(await a.setAccess(operator.id, change({ role: "operator", expectedRevision: 1 })), 200);
  for (const [id, body] of [
    ["auth.registration.settings.set", { enabled: true, expectedRevision: 0 }],
    ["auth.methods.settings.set", { enabled: ["usernamePassword"], expectedRevision: 0 }],
  ]) {
    const route = a.auth.routes.find((entry) => entry.id === id);
    const response = await route.handler({ request, principal, body, params: {} });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "account_access_forbidden");
  }
  assert.deepEqual(await expectStatus(await a.send("registration/settings", "GET"), 200), { enabled: false, revision: 0 });
  assert.equal((await expectStatus(await a.send("methods/settings", "GET"), 200)).revision, 0);
});

test("an administrator creates an account with its username and password in one request", async (t) => {
  const a = await platform(t, { registration: false });
  const created = await a.create("staff", "operator");
  assert.deepEqual([created.username, created.roles, created.kind], ["staff", ["operator"], "human"]);
  assert.equal("passwordHashPHC" in created, false);
  assert.equal((await a.signIn("staff")) !== undefined, true, "registration closed does not stop an administrator");
  assert.equal((await expectStatus(await a.send("accounts", "POST", { username: "staff", password: PASSWORD }), 409)).code, "username_taken");
  assert.equal((await expectStatus(await a.send("accounts", "POST", { username: "other", password: PASSWORD, role: "owner" }), 400)).code, "invalid_role");
  assert.equal((await expectStatus(await a.send("accounts", "POST", { username: "other", password: "short" }), 400)).code, "password_too_short");
  assert.equal((await expectStatus(await a.send("accounts", "POST", { username: "other", password: PASSWORD, secretHash: "x" }), 400)).code, "invalid_request");
  // An operator who manages users gives only roles it holds.
  await expectStatus(await a.setAccess(created.id, change({ role: "operator", permissions: ["system.users.manage"] })), 200);
  const operator = await a.signIn("staff");
  assert.equal((await expectStatus(await a.send("accounts", "POST", { username: "reseller", password: PASSWORD, role: "reseller" }, operator), 403)).code, "account_access_forbidden");
  await expectStatus(await a.send("accounts", "POST", { username: "helper", password: PASSWORD, role: "operator" }, operator), 201);
  assert.equal((await a.call("credentials", { method: "POST", body: {}, headers: a.bearer(a.owner.tokens) })).status, 404, "POST /auth/credentials is gone");
});

test("accounts list a page at a time, and one account by id", async (t) => {
  const a = await platform(t);
  for (const name of ["one", "two", "three"]) await a.create(name);
  const first = await expectStatus(await a.send("accounts?limit=2", "GET"), 200);
  assert.equal(first.accounts.length, 2);
  assert.equal(first.accounts[0].username, "owner");
  const second = await expectStatus(await a.send(`accounts?limit=2&after=${first.next}`, "GET"), 200);
  assert.deepEqual(second.accounts.map((account) => account.username), ["two", "three"]);
  assert.equal(second.next, undefined);
  const one = await expectStatus(await a.send(`accounts?accountId=${first.accounts[1].id}`, "GET"), 200);
  assert.deepEqual(one.accounts.map((account) => account.username), ["one"]);
  assert.equal((await a.call("accounts", { headers: a.bearer(await a.signIn("one")) })).status, 403);
});

test("administrators list and end another account's sessions, never the owner's without the owner's authority", async (t) => {
  const a = await platform(t);
  const target = await a.create("target");
  const first = await a.signIn("target");
  await a.signIn("target");
  const listed = await expectStatus(await a.send(`accounts/${target.id}/sessions`, "GET"), 200);
  assert.equal(listed.sessions.length, 2);
  const one = listed.sessions[0].sessionId;
  await expectStatus(await a.send(`accounts/${target.id}/sessions/${one}`, "DELETE"), 204);
  assert.equal((await expectStatus(await a.send(`accounts/${target.id}/sessions/${one}`, "DELETE"), 404)).code, "session_not_found");
  assert.equal((await expectStatus(await a.send(`accounts/${target.id}/sessions`, "DELETE"), 200)).revoked.length, 1);
  assert.equal((await a.call("session", { headers: a.bearer(first) })).status, 401);

  const operator = await a.create("operator", "operator");
  await expectStatus(await a.setAccess(operator.id, change({ role: "operator", permissions: ["system.users.manage"] })), 200);
  const operatorTokens = await a.signIn("operator");
  assert.equal((await expectStatus(await a.send(`accounts/${a.owner.userId}/sessions`, "DELETE", undefined, operatorTokens), 403)).code, "account_access_forbidden");
  await expectStatus(await a.call("session", { headers: a.bearer(a.owner.tokens) }), 200);
  assert.ok((await eventsOf(a)).includes("session.revoked"));
});

test("an administrator resets another account's second factor; an operator cannot reset the owner", async (t) => {
  const a = await platform(t);
  const key = totpKey(TEST_MASTER_SECRET);
  const enroll = async (userId) => {
    const { secret } = await a.run(a.core.mutation({ ip: null }, (tx) => createTotp(tx, { userId, issuerDisplayName: "Zelavis", accountDisplayName: "x", key })));
    const code = await a.run(totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, a.clock.now));
    const confirmed = await a.run(a.core.mutation({ ip: null }, (tx) => confirmTotp(tx, { userId, code, key })));
    assert.equal(confirmed.success, true);
    a.clock.now += 30_000;
  };
  const target = await a.create("target");
  await a.signIn("target");
  await enroll(target.id);
  await enroll(a.owner.userId);
  const operator = await a.create("operator", "operator");
  await expectStatus(await a.setAccess(operator.id, change({ role: "operator", permissions: ["system.users.manage"] })), 200);
  // The operator signs in before its factor-less account would need one; no policy is set.
  const operatorTokens = await a.signIn("operator");

  assert.equal((await expectStatus(await a.send(`accounts/${a.owner.userId}/mfa`, "DELETE", undefined, operatorTokens), 403)).code, "account_access_forbidden");
  const ownerSecrets = (await a.rows(totpTables.totpSecrets)).filter((row) => row.userId === a.owner.userId);
  assert.equal(ownerSecrets.length, 1, "the refused reset removed nothing");

  assert.deepEqual(await expectStatus(await a.send(`accounts/${target.id}/mfa`, "DELETE", undefined, operatorTokens), 200), { removed: 1 });
  assert.equal((await a.rows(totpTables.totpSecrets)).filter((row) => row.userId === target.id).length, 0);
  assert.equal((await a.rows(totpTables.backupCodes)).filter((row) => row.userId === target.id).length, 0);
  assert.equal((await a.rows(coreTables.sessions)).filter((row) => row.userId === target.id).length, 0, "the reset ended its sessions");
  const reset = (await a.rows(securityTables.events)).find((event) => event.kind === "mfa.reset");
  assert.deepEqual([reset.accountId, reset.actorId, reset.detail.removed], [target.id, operator.id, 1]);
  assert.equal((await expectStatus(await a.send(`accounts/${"0".repeat(32)}/mfa`, "DELETE"), 404)).code, "account_not_found");
});

// --- import (ported from test/auth-account-import.test.mjs) ----------------------------------------------------------

const djangoHash = (password, salt, iterations = 120_000) =>
  `pbkdf2_sha256$${iterations}$${salt}$${pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64")}`;
// Generated with `htpasswd -bnBC 5 "" short` (Apache's bcrypt).
const BCRYPT_SHORT = "$2y$05$guQQF.7Y1briSwnHQRZ4Ou5JPGuMKhbQRR9PjATYyaTkdpfnXdrzq";
// Firebase's published example (github.com/firebase/scrypt): password "user1password".
const FIREBASE = {
  hashConfig: { algorithm: "firebase-scrypt", signerKey: "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==", saltSeparator: "Bw==", rounds: 8, memCost: 14 },
  passwordHash: "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
  passwordSalt: "42xEC+ixf3L2lw==",
};
const djangoScrypt = (password, salt) => `scrypt$16384$${salt}$8$1$${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;

async function importer(t, options = {}) {
  const a = await platform(t, { emailOutbox: recordingOutbox(), ...options });
  const importing = (body) => a.send("accounts/import", "POST", body);
  const signInEmail = (email, password) => a.call("email-password/sign-in", { method: "POST", body: { email, password } });
  const signInUsername = (username, password) => a.call("username-password/sign-in", { method: "POST", body: { username, password } });
  const storedHash = async (userId) => (await a.rows(passwordTables.passwords)).find((row) => row.userId === userId)?.passwordHashPHC;
  return { ...a, importing, signInEmail, signInUsername, storedHash };
}

test("accounts import with their profiles; verifiable password hashes sign in, others need a reset", async (t) => {
  const a = await importer(t);
  const accounts = [
    { email: "Ada@Example.com", displayName: "Ada", verified: true, metadata: { plan: "pro" }, passwordHash: djangoHash("ada's long passphrase!", "s4lty") },
    { username: "grace", displayName: "Grace", passwordHash: "md5$1a2b$0123456789abcdef0123456789abcdef" },
    { email: "linus@example.com", verified: true },
  ];
  const plan = await expectStatus(await a.importing({ accounts, dryRun: true }), 200);
  assert.deepEqual([plan.created, plan.needsReset, plan.problems], [0, ["grace", "linus@example.com"], []]);
  assert.notEqual((await a.signInEmail("ada@example.com", "ada's long passphrase!")).status, 200, "a dry run writes nothing");

  const done = await expectStatus(await a.importing({ accounts }), 200);
  assert.deepEqual([done.created, done.skipped, done.needsReset], [3, [], ["grace", "linus@example.com"]]);
  assert.equal((await a.signInEmail("ADA@example.com", "ada's long passphrase!")).status, 200, "a Django PBKDF2 hash signs in after import");
  assert.equal((await expectStatus(await a.signInUsername("grace", "anything at all here"), 401)).code, "invalid_credentials");
  assert.equal((await expectStatus(await a.signInEmail("linus@example.com", "anything at all here"), 401)).code, "invalid_credentials");

  const again = await expectStatus(await a.importing({ accounts }), 200);
  assert.deepEqual([again.created, again.skipped.map((entry) => entry.identifier)], [0, ["ada@example.com", "grace", "linus@example.com"]]);

  const bad = await expectStatus(await a.importing({ accounts: [{ email: "not an email" }, { displayName: "nobody" }, { email: "x@y.z", verified: true }, { email: "X@Y.z", verified: true }, { email: "unverified@example.com" }] }), 200);
  assert.deepEqual(bad.problems.map((entry) => entry.row), [1, 2, 4, 5]);
  assert.equal(bad.created, 0, "with any problem nothing is written");
  const ada = (await a.rows(accountsTables.accounts)).find((row) => row.displayName === "Ada");
  assert.deepEqual([ada.metadata.plan, ada.metadata["zelavis.import"].password], ["pro", "carried"]);
  assert.ok((await eventsOf(a)).includes("account.imported"));
});

test("bcrypt, scrypt and Firebase hashes sign in once and are then replaced by Zelavis's own", async (t) => {
  const a = await importer(t);
  const accounts = [
    { username: "brook", passwordHash: BCRYPT_SHORT },
    { email: "sam@example.com", verified: true, passwordHash: djangoScrypt("sam's scrypt passphrase", "pepper") },
    { email: "fire@example.com", verified: true, passwordHash: FIREBASE.passwordHash, passwordSalt: FIREBASE.passwordSalt },
    { email: "nosalt@example.com", verified: true, passwordHash: FIREBASE.passwordHash },
  ];
  const done = await expectStatus(await a.importing({ accounts, hashConfig: FIREBASE.hashConfig }), 200);
  assert.deepEqual([done.created, done.rehashOnSignIn, done.needsReset], [4, ["brook", "sam@example.com", "fire@example.com"], ["nosalt@example.com"]]);
  const brook = (await a.rows(usernameTables.usernames)).find((row) => row.username === "brook");
  assert.match(await a.storedHash(brook.userId), /^\$2y\$05\$/, "kept as it came until its owner signs in");

  const firstShort = await expectStatus(await a.signInUsername("brook", "short"), 200);
  assert.match(await a.storedHash(brook.userId), /^\$pbkdf2-sha256\$i=600000\$/);
  await expectStatus(await a.signInUsername("brook", "short"), 200);
  await expectStatus(await a.send("username-password/change-password", "POST", {
    currentPassword: "short", newPassword: "another long password here",
  }, firstShort.tokens), 200);
  assert.equal((await expectStatus(await a.signInUsername("brook", "short"), 400)).code, "password_too_short");
  for (const [identifier, password, signIn] of [["sam@example.com", "sam's scrypt passphrase", a.signInEmail], ["fire@example.com", "user1password", a.signInEmail]]) {
    const first = await expectStatus(await signIn(identifier, password), 200);
    assert.match(await a.storedHash(first.userId), /^\$pbkdf2-sha256\$i=600000\$/, `${identifier}'s hash is replaced at that sign-in`);
    await expectStatus(await signIn(identifier, password), 200);
  }
  assert.notEqual((await a.signInEmail("sam@example.com", "a wrong scrypt passphrase")).status, 200, "a wrong password does not match");
  assert.equal((await a.importing({ accounts: [{ email: "a@b.c", verified: true }], hashConfig: { algorithm: "argon2" } })).status, 400, "an unknown hashConfig is refused, never ignored");
  assert.equal((await a.importing({ accounts: [{ email: "a@b.c", verified: true }], hashConfig: { algorithm: "firebase-scrypt" } })).status, 400);
});

test("large imports and account pages stay inside the transaction read budget", async (t) => {
  const a = await importer(t);
  const accounts = Array.from({ length: 260 }, (_, index) => ({
    username: `import-member-${index}`, email: `member-${index}@example.test`, verified: true,
  }));
  const dryRun = await expectStatus(await a.importing({ accounts, dryRun: true }), 200);
  assert.deepEqual([dryRun.accounts, dryRun.created, dryRun.needsReset.length], [260, 0, 260]);
  const applied = await expectStatus(await a.importing({ accounts: accounts.slice(0, 132) }), 200);
  assert.equal(applied.created, 132);
  const first = await expectStatus(await a.send("accounts?limit=200", "GET"), 200);
  const second = await expectStatus(await a.send(`accounts?limit=200&after=${first.next}`, "GET"), 200);
  assert.equal(first.accounts.length + second.accounts.length, 133);
  assert.equal(new Set([...first.accounts, ...second.accounts].map((account) => account.id)).size, 133);
  assert.equal(second.next, undefined);
});

test("verified email passwords sign in with no outbox configured", async (t) => {
  const a = await importer(t, { emailOutbox: undefined });
  const email = "ada@example.test";
  await expectStatus(await a.importing({ accounts: [{
    email, verified: true, passwordHash: djangoHash(PASSWORD, "salt"),
  }] }), 200);
  const listed = await expectStatus(await a.call("methods"), 200);
  assert.deepEqual(listed.methods.find((entry) => entry.name === "emailPassword"), {
    name: "emailPassword", signIn: true, signUp: false, recovery: false, reason: "email_unavailable",
  });
  await expectStatus(await a.signInEmail(email, PASSWORD), 200);
  for (const [path, body] of [
    ["email-password/sign-up", { email: "new@example.test", password: PASSWORD }],
    ["email-password/recovery/start", { email }],
  ]) {
    assert.equal((await expectStatus(await a.call(path, { method: "POST", body }), 409)).code, "email_unavailable");
  }
});

test("method disablement reaches the session transaction and invalidates old MFA challenges", async (t) => {
  const a = await importer(t);
  const email = "mfa@example.test";
  await expectStatus(await a.importing({ accounts: [{ email, verified: true, passwordHash: djangoHash(PASSWORD, "salt") }] }), 200);
  const initial = await expectStatus(await a.signInEmail(email, PASSWORD), 200);
  const key = totpKey(TEST_MASTER_SECRET);
  const { secret } = await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) =>
    createTotp(tx, { userId: initial.userId, key, issuerDisplayName: "Zelavis", accountDisplayName: email })));
  const codeAt = () => a.run(totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, a.clock.now));
  const enrollmentCode = await codeAt();
  assert.equal((await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) =>
    confirmTotp(tx, { userId: initial.userId, key, code: enrollmentCode })))).success, true);
  a.clock.now += 30_000;
  const first = await expectStatus(await a.signInEmail(email, PASSWORD), 200);
  assert.equal(first.status, "mfa_required");
  await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["usernamePassword", "emailPassword"], expectedRevision: 0 }), 200);
  const verify = async (challenge) => a.call("mfa/verify", { method: "POST", body: { challenge, code: await codeAt() } });
  await expectStatus(await verify(first.challenge), 200);
  a.clock.now += 30_000;
  const pending = await expectStatus(await a.signInEmail(email, PASSWORD), 200);
  await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["usernamePassword"], expectedRevision: 1 }), 200);

  await assert.rejects(a.run(a.auth.methods.emailPassword.signInWithEmailPassword(NO_REQUEST, { email, password: PASSWORD })), { _tag: "MethodDisabled" });
  assert.equal((await expectStatus(await verify(pending.challenge), 400)).code, "invalid_challenge");
  await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["usernamePassword", "emailPassword"], expectedRevision: 2 }), 200);
  assert.equal((await expectStatus(await verify(pending.challenge), 400)).code, "invalid_challenge");
  const current = await expectStatus(await a.signInEmail(email, PASSWORD), 200);
  assert.equal((await expectStatus(await verify(current.challenge), 200)).userId, initial.userId);
});

test("only hashes that can be verified here are carried over", () => {
  assert.match(portablePasswordHash(djangoHash("x", "salt")), /^pbkdf2-sha256\$120000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
  assert.equal(portablePasswordHash(djangoHash("x", "salt", 10_000)), undefined, "too few iterations");
  assert.equal(portablePasswordHash("$2b$10$abcdefghijklmnopqrstuuSomethingElse"), undefined, "a malformed bcrypt hash");
  assert.equal(portablePasswordHash(BCRYPT_SHORT), BCRYPT_SHORT);
  assert.equal(portablePasswordHash(BCRYPT_SHORT.replace("$05$", "$15$")), undefined, "a bcrypt cost above 14 is too slow to verify at sign-in");
  assert.match(portablePasswordHash(`bcrypt_sha256$${BCRYPT_SHORT}`), /^bcrypt-sha256\$\$2y\$/);
  assert.match(portablePasswordHash(djangoScrypt("x", "salt")), /^scrypt\$14\$8\$1\$c2FsdA\$/);
  assert.equal(portablePasswordHash("scrypt$1048576$salt$8$1$aGFzaGhhc2hoYXNoaGFzaA=="), undefined, "scrypt above 64 MiB");
  assert.equal(portablePasswordHash(FIREBASE.passwordHash, { salt: FIREBASE.passwordSalt }), undefined, "Firebase needs its hashConfig");
  const own = "pbkdf2-sha256$600000$yLraSn-7jde16kwYd-a7HQ$PjucgodjtQ-_xh7HLdhK_1NkRdh708YnHfRZ3wl52ag";
  assert.equal(portablePasswordHash(own), own);
  const phc = "$pbkdf2-sha256$i=600000$yLraSn+7jde16kwYd+a7HQ$PjucgodjtQ+/xh7HLdhK/1NkRdh708YnHfRZ3wl52ag";
  assert.equal(portablePasswordHash(phc), phc);
});

// --- security events and the methods catalogue ---------------------------------------------------------------------

test("security events record sign-ins, failures and administration without secrets, and are kept 90 days", async (t) => {
  const a = await platform(t, { emailOutbox: recordingOutbox() });
  const target = await a.create("target");
  const tokens = await a.signIn("target");
  assert.equal((await a.call("username-password/sign-in", { method: "POST", body: { username: "target", password: "a wrong password here" } })).status, 401);
  assert.equal((await a.call("username-password/sign-in", { method: "POST", body: { username: "nobody", password: PASSWORD } })).status, 404);
  assert.equal((await a.call("email-password/sign-in", { method: "POST", body: { email: "secret.person@example.test", password: PASSWORD } })).status, 404);
  await expectStatus(await a.call("session", { method: "DELETE", body: { refreshToken: tokens.refreshToken } }), 204);
  await expectStatus(await a.setAccess(target.id, change({ grants: [grant("project.view")] })), 200);

  const page = await expectStatus(await a.send("security/events?limit=3", "GET"), 200);
  assert.equal(page.events.length, 3);
  assert.equal(typeof page.next, "string");
  const all = [];
  for (let before; ;) {
    const listed = await expectStatus(await a.send(`security/events?limit=2${before === undefined ? "" : `&before=${before}`}`, "GET"), 200);
    all.push(...listed.events);
    if (listed.next === undefined) break;
    before = listed.next;
  }
  const kinds = all.map((event) => event.type);
  for (const kind of ["bootstrap.owner_created", "account.created", "authentication.succeeded", "authentication.failed", "session.ended", "account.access.changed"]) {
    assert.ok(kinds.includes(kind), `${kind} in ${kinds}`);
  }
  assert.equal(new Set(all.map((event) => event.id)).size, all.length, "no event is listed twice");
  const failed = all.filter((event) => event.type === "authentication.failed");
  assert.equal(failed.length, 3);
  assert.ok(failed.every((event) => typeof event.subjectHash === "string" && event.subjectHash.length > 20));

  // Nothing stored names a password, a token or the address a failed attempt tried.
  const stored = JSON.stringify(await a.documents(securityTables.events));
  for (const secret of [PASSWORD, "a wrong password here", tokens.refreshToken, tokens.accessToken, "secret.person@example.test", "nobody", "198.51.100.7"]) {
    assert.equal(stored.includes(secret), false, `security events hold ${secret}`);
  }

  const count = (await a.rows(securityTables.events)).length;
  a.clock.now += SECURITY_EVENT_RETENTION_MS + 1;
  const sweep = createSecurityRetentionSweep(a.tenant, () => a.clock.now);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), count);
  assert.equal((await a.rows(securityTables.events)).length, 0);
  await expectStatus(await a.call("username-password/sign-in", { method: "POST", body: { username: "target", password: PASSWORD } }), 200);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 0, "a recent event is kept");
});

test("the methods catalogue lists enabled methods with what each can do now", async (t) => {
  const outbox = recordingOutbox();
  outbox.linkBaseUrl = undefined;
  const a = await platform(t, { emailOutbox: outbox, registration: true });
  const listed = await expectStatus(await a.call("methods"), 200);
  assert.deepEqual(listed.registration, { enabled: true });
  const byName = Object.fromEntries(listed.methods.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.emailPassword, { name: "emailPassword", signIn: true, signUp: false, recovery: false, reason: "email_unavailable" });
  assert.deepEqual(byName.usernamePassword, { name: "usernamePassword", signIn: true, signUp: true, recovery: false });
  assert.equal(byName.usernamePasskey.reason, "passkey_unconfigured", "passkeys on a localhost relying party serve only localhost");
  outbox.linkBaseUrl = new URL("https://example.test/");
  const delivering = Object.fromEntries((await expectStatus(await a.call("methods"), 200)).methods.map((entry) => [entry.name, entry]));
  assert.deepEqual(delivering.emailPassword, { name: "emailPassword", signIn: true, signUp: true, recovery: true });

  const settings = await expectStatus(await a.send("methods/settings", "GET"), 200);
  assert.deepEqual(settings, { enabled: ["usernamePassword", "emailPassword", "usernamePasskey"], revision: 0 });
  assert.equal((await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["bogus"], expectedRevision: 0 }), 400)).code, "invalid_request");
  for (const enabled of [[], ["emailPassword"], ["usernamePasskey"]]) {
    assert.equal((await expectStatus(await a.send("methods/settings", "PUT", { enabled, expectedRevision: 0 }), 409)).code, "owner_sign_in_required");
  }
  assert.deepEqual(await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["emailPassword", "usernamePassword"], expectedRevision: 0 }), 200), { enabled: ["emailPassword", "usernamePassword"], revision: 1 });
  assert.equal((await expectStatus(await a.send("methods/settings", "PUT", { enabled: [], expectedRevision: 0 }), 409)).code, "methods_settings_conflict");
  assert.deepEqual((await expectStatus(await a.call("methods"), 200)).methods.map((entry) => entry.name), ["emailPassword", "usernamePassword"]);
  assert.equal((await expectStatus(await a.call("username-passkey/sign-in/start", { method: "POST", body: {} }), 404)).code, "method_disabled");
  assert.ok(await a.signIn("owner"));
  await expectStatus(await a.call("username-password/change-password", { method: "POST", body: { currentPassword: PASSWORD, newPassword: "an entirely new battery staple" }, headers: a.bearer(a.owner.tokens) }), 200);

  await expectStatus(await a.send("registration/settings", "PUT", { enabled: false, expectedRevision: 0 }), 200);
  const closed = (await expectStatus(await a.call("methods"), 200));
  assert.deepEqual(closed.methods[0], { name: "emailPassword", signIn: true, signUp: false, recovery: true, reason: "registration_closed" });
  assert.deepEqual(closed.registration, { enabled: false });
  assert.equal((await a.call("methods/settings")).status, 401);
});

test("method settings retain the password route of an email-only Platform owner", async (t) => {
  const a = await platform(t);
  const username = (await a.rows(usernameTables.usernames)).find((entry) => entry.userId === a.owner.userId);
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.delete(usernameTables.usernames, username._id)));
  const email = "owner@example.test";
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.insert(emailTables.verifiedEmails, {
    userId: a.owner.userId, email, normalizedEmail: email, isPrimary: true,
  })));
  assert.equal((await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["usernamePassword"], expectedRevision: 0 }), 409)).code, "owner_sign_in_required");
  await expectStatus(await a.send("methods/settings", "PUT", { enabled: ["emailPassword"], expectedRevision: 0 }), 200);
  assert.equal((await expectStatus(await a.call("email-password/sign-in", { method: "POST", body: { email, password: PASSWORD } }), 200)).userId, a.owner.userId);
});

test("second-factor changes are security events, each recorded with its action", async (t) => {
  const a = await platform(t);
  const code = (secret) => a.run(totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, a.clock.now));
  const kinds = async () => (await a.rows(securityTables.events)).map((event) => event.kind);
  const started = await expectStatus(await a.send("mfa/totp", "POST", { password: PASSWORD }), 200);
  const confirmed = await expectStatus(await a.send("mfa/totp/confirm", "POST", { totpId: started.totpId, code: await code(started.secret) }), 200);
  assert.ok((await kinds()).includes("mfa.enrolled"));
  a.clock.now += 30_000;
  // Activating the first authenticator kept the session that enrolled it.
  const refused = await a.send("mfa/backup-codes", "POST", { code: "000000" });
  assert.equal(refused.status, 400);
  assert.ok((await kinds()).includes("mfa.verification_failed"), "a refused code is recorded although the request failed");
  await expectStatus(await a.send("mfa/backup-codes", "POST", { code: await code(started.secret) }), 200);
  assert.ok((await kinds()).includes("mfa.backup_codes_replaced"));
  a.clock.now += 30_000;
  await expectStatus(await a.send(`mfa/totp/${confirmed.totpId}`, "DELETE", { code: await code(started.secret) }), 200);
  assert.ok((await kinds()).includes("mfa.removed"));
  const policy = await expectStatus(await a.send("mfa/policy", "GET"), 200);
  await expectStatus(await a.send("mfa/policy", "PUT", { requiredFor: "privileged", expectedRevision: policy.revision }), 200);
  const changed = (await a.rows(securityTables.events)).find((event) => event.kind === "mfa.policy.changed");
  assert.deepEqual([changed.actorId, changed.detail.requiredFor], [a.owner.userId, "privileged"]);
  // A refused change records nothing.
  const before = (await a.rows(securityTables.events)).length;
  assert.equal((await a.send("mfa/policy", "PUT", { requiredFor: "all", expectedRevision: policy.revision })).status, 409);
  assert.equal((await a.rows(securityTables.events)).length, before);
});
