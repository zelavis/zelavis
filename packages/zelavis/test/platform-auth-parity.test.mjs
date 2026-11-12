// Authentication's operations through the HTTP route, the SDK and the CLI, each against a Platform of its own: the same scenario
// has to answer the same, refusals included. Sign-in and the owner bootstrap are checked by what they refuse, since a bare
// Platform has no credential to sign in with.
import assert from "node:assert/strict";
import test from "node:test";
import { runAuthCommand } from "../dist/cli/auth.js";
import { createInMemoryAuthRepositories } from "../dist/app/identity/index.js";
import { outcome, platform } from "./_runtime.mjs";

const normalized = (value) => JSON.parse(JSON.stringify(value).replace(/security_event_[0-9a-f-]+/g, "security_event_ID").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "UUID"));

test("conditional account access has HTTP, SDK and CLI parity", async (t) => {
  const input = { expectedRevision: 0, role: "operator", permissions: ["projects.list"], grants: [] };
  const answers = [];
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t);
    await p.client.auth.admin.createAccount({ id: "target", username: "target", roles: ["customer"] });
    const set = {
      http: () => p.send("PUT", "/auth/accounts/target/access", input),
      sdk: () => p.client.auth.admin.setAccountAccess("target", input),
      cli: () => p.cli(runAuthCommand, ["set-account-access", "target", "--data", JSON.stringify(input)]),
    }[surface];
    const applied = await set();
    assert.deepEqual(applied, { accountId: "target", accessRevision: 1, role: "operator", permissions: ["projects.list"], grants: [] });
    const [listed] = await p.client.auth.admin.accounts("target");
    assert.equal(listed.accessRevision, 1);
    assert.equal("sessionEpoch" in listed, false);
    const [event] = (await p.client.auth.admin.securityEvents()).events;
    assert.deepEqual(Object.keys(event).sort(), ["accessRevision", "accountId", "actorId", "id", "occurredAt", "type"]);
    assert.equal(event.type, "account.access.changed");
    assert.equal(event.actorId, "owner");
    assert.equal(event.accountId, "target");
    assert.equal(event.accessRevision, 1);
    const stale = await outcome(set);
    assert.match(stale.refused, /access revision has changed/);
    p.as({ id: "delegate", type: "user", permissions: ["system.users.manage"] });
    const refused = await outcome(() => p.client.auth.admin.setAccountAccess("target", { ...input, expectedRevision: 1 }));
    assert.match(refused.refused, /cannot delegate/);
    answers.push({ applied, stale, refused });
  }
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);
});

test("a failed access audit reports the committed revision and the account is readable", async (t) => {
  const repositories = createInMemoryAuthRepositories();
  repositories.securityEvents.append = async () => { throw new Error("private audit backend detail"); };
  const p = await platform(t, { subsystems: { auth: { authOptions: { repositories } } } });
  await p.client.auth.admin.createAccount({ id: "target", username: "target", roles: ["customer"] });
  const input = { expectedRevision: 0, role: "customer", permissions: ["projects.list"], grants: [] };
  await assert.rejects(p.client.auth.admin.setAccountAccess("target", input), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.body.code, "account_access_audit_failed");
    assert.equal(error.body.accessRevision, 1);
    assert.doesNotMatch(error.message, /private audit backend detail/);
    return true;
  });
  const [account] = await p.client.auth.admin.accounts("target");
  assert.equal(account.accessRevision, 1);
  assert.deepEqual(account.permissions, input.permissions);
  await assert.rejects(p.client.auth.admin.setAccountAccess("target", input), { status: 409 });
  assert.equal((await p.client.auth.admin.setAccountAccess("target", { ...input, expectedRevision: 1 })).accessRevision, 1);
});

test("delegated administrators cannot gain authority through neighboring account operations", async (t) => {
  const p = await platform(t);
  await p.client.auth.admin.createAccount({ id: "elevated", username: "elevated", permissions: ["projects.create"] });
  const { serviceAccount } = await p.client.auth.admin.createServiceAccount({ name: "Elevated service", permissions: ["projects.create"] });
  p.as({ id: "delegate", type: "user", grants: [{ permission: "system.users.manage", scope: { type: "system" } }] });
  for (const input of [
    { id: "extra-owner", username: "extra-owner", roles: ["owner"] },
    { id: "system", username: "system", metadata: { principalType: "service" } },
    { id: "wrong-tenant", username: "wrong-tenant", metadata: { tenantId: "customer-tenant" } },
    { id: "too-powerful", username: "too-powerful", permissions: ["projects.create"] },
    { id: "scope-upgrade", username: "scope-upgrade", permissions: ["system.users.manage"] },
  ]) {
    await assert.rejects(p.client.auth.admin.createAccount(input), { status: 403 });
  }
  await assert.rejects(p.client.auth.admin.createServiceAccount({ name: "Excess authority", permissions: ["projects.create"] }), { status: 403 });
  await assert.rejects(p.client.auth.admin.rotateServiceAccountToken(serviceAccount.id), { status: 403 });
  await assert.rejects(p.client.auth.admin.setServiceAccountTenant(serviceAccount.id, "elsewhere"), { status: 403 });
  await assert.rejects(p.client.auth.admin.revokeServiceAccount(serviceAccount.id), { status: 403 });
  await assert.rejects(p.client.auth.admin.revokeAccountSessions("elevated"), { status: 403 });
  const credential = { id: "new-credential", provider: "password", identifier: "new-identifier" };
  await assert.rejects(p.client.auth.admin.createCredentials({ ...credential, accountId: "elevated" }), { status: 403 });
  const target = await p.client.auth.admin.createAccount({ id: "ordinary", username: "ordinary" });
  const created = await p.client.auth.admin.createCredentials({ ...credential, accountId: target.id });
  assert.equal(created.accountId, target.id);
  assert.equal("secretHash" in created, false);
  const importResult = await p.client.auth.admin.importAccounts({
    accounts: [{ username: "reserved", verified: true, metadata: { tenantId: "other-tenant" } }],
  });
  assert.equal(importResult.created, 0);
  assert.match(importResult.problems[0].reason, /reserved identity field/);
});

test("authentication answers the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const account = { id: "ann", email: "ann@example.com", displayName: "Ann" };
  const credentials = { accountId: "ann", provider: "password", identifier: "ann@example.com" };
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t);
    const json = (value) => JSON.stringify(value);
    const steps = {
      http: [
        () => p.send("GET", "/auth/providers"), () => p.send("GET", "/auth/oauth/providers"), () => p.send("GET", "/auth/recovery/providers"),
        () => p.send("GET", "/auth/bootstrap"), () => p.send("POST", "/auth/bootstrap", { bootstrapToken: "wrong" }),
        () => p.send("GET", "/auth/accounts"), () => p.send("POST", "/auth/accounts", account), () => p.send("GET", "/auth/accounts"),
        () => p.send("POST", "/auth/credentials", credentials),
        () => p.send("GET", "/auth/accounts/ann/sessions"), () => p.send("DELETE", "/auth/accounts/ann/sessions"), () => p.send("DELETE", "/auth/accounts/ann/sessions/nope"),
        () => p.send("GET", "/auth/session"), () => p.send("GET", "/auth/sessions"), () => p.send("DELETE", "/auth/sessions/nope"),
        () => p.send("POST", "/auth/authenticate/password", { identifier: "ann@example.com", password: "wrong" }),
        () => p.send("POST", "/auth/recovery/password", { identifier: "ann@example.com" }), () => p.send("POST", "/auth/recovery/password/complete", {}),
        () => p.send("POST", "/auth/oauth/nope/start"), () => p.send("POST", "/auth/oauth/nope/link/start"),
        () => p.send("GET", "/auth/oauth/connections"), () => p.send("DELETE", "/auth/oauth/connections/nope"),
        () => p.send("GET", "/auth/security/events").then((answer) => ({ count: answer.events.length })),
      ],
      sdk: [
        () => p.client.auth.providers(), () => p.client.auth.oauthProviders(), () => p.client.auth.recoveryProviders(),
        () => p.client.auth.bootstrapStatus(), () => p.client.auth.bootstrap({ bootstrapToken: "wrong" }),
        () => p.client.auth.admin.accounts(), () => p.client.auth.admin.createAccount(account), () => p.client.auth.admin.accounts(),
        () => p.client.auth.admin.createCredentials(credentials),
        () => p.client.auth.admin.accountSessions("ann"), () => p.client.auth.admin.revokeAccountSessions("ann"), () => p.client.auth.admin.revokeAccountSession("ann", "nope"),
        () => p.client.auth.getSession(), () => p.client.auth.sessions(), () => p.client.auth.revokeSession("nope"),
        () => p.client.auth.signInWithPassword({ identifier: "ann@example.com", password: "wrong" }),
        () => p.client.auth.beginRecovery("password", { identifier: "ann@example.com" }), () => p.client.auth.completeRecovery("password", {}),
        () => p.client.auth.signInWithOAuth("nope"), () => p.client.auth.linkIdentity("nope"),
        () => p.client.auth.admin.oauthConnections(), () => p.client.auth.admin.removeOAuth("nope"),
        () => p.client.auth.admin.securityEvents().then((answer) => ({ count: answer.events.length })),
      ],
      cli: [
        () => p.cli(runAuthCommand, ["providers"]), () => p.cli(runAuthCommand, ["oauth-providers"]), () => p.cli(runAuthCommand, ["recovery-providers"]),
        () => p.cli(runAuthCommand, ["bootstrap-status"]), () => p.cli(runAuthCommand, ["bootstrap", "--data", json({ bootstrapToken: "wrong" })]),
        () => p.cli(runAuthCommand, ["accounts"]), () => p.cli(runAuthCommand, ["create-account", "--data", json(account)]), () => p.cli(runAuthCommand, ["accounts"]),
        () => p.cli(runAuthCommand, ["create-credentials", "--data", json(credentials)]),
        () => p.cli(runAuthCommand, ["account-sessions", "ann"]), () => p.cli(runAuthCommand, ["revoke-account-sessions", "ann"]), () => p.cli(runAuthCommand, ["revoke-account-session", "ann", "nope"]),
        () => p.cli(runAuthCommand, ["session"]), () => p.cli(runAuthCommand, ["sessions"]), () => p.cli(runAuthCommand, ["revoke-session", "nope"]),
        () => p.cli(runAuthCommand, ["sign-in", "password", "--data", json({ identifier: "ann@example.com", password: "wrong" })]),
        () => p.cli(runAuthCommand, ["recover", "password", "--data", json({ identifier: "ann@example.com" })]), () => p.cli(runAuthCommand, ["complete-recovery", "password", "--data", "{}"]),
        () => p.cli(runAuthCommand, ["oauth-start", "nope"]), () => p.cli(runAuthCommand, ["link-start", "nope"]),
        () => p.cli(runAuthCommand, ["oauth-connections"]), () => p.cli(runAuthCommand, ["remove-oauth", "nope"]),
        () => p.cli(runAuthCommand, ["security-events"]).then((answer) => ({ count: answer.events.length })),
      ],
    };
    results[surface] = [];
    for (const step of steps[surface]) results[surface].push(await outcome(step));
  }
  // The void operations answer `{ revoked | recovered | removed: true }` in the CLI and nothing from the route and the SDK: compare them by success.
  // The SDK's `oauthConnections()` has always handed over the providers themselves, where the route wraps them.
  const unwrap = (entry) => entry.answer && typeof entry.answer === "object" && !Array.isArray(entry.answer) && Object.keys(entry.answer).join() === "providers" ? { answer: entry.answer.providers } : entry;
  const brief = (list) => normalized(list.map(unwrap).map((entry) => entry.answer !== undefined && entry.answer !== null && typeof entry.answer === "object" && ["revoked", "recovered", "removed", "signedOut"].some((key) => key in entry.answer && entry.answer[key] === true) ? { answer: "done" } : entry.answer === null ? { answer: "done" } : entry));
  const accepted = results.http.filter((entry) => entry.answer !== undefined).length;
  assert.ok(accepted >= 10, `much of the scenario is accepted (${accepted})`);
  assert.deepEqual(results.http[6].answer.id, "ann", "an account is created");
  assert.equal(results.http[7].answer.length, 1, "and listed");
  assert.deepEqual(brief(results.sdk), brief(results.http));
  assert.deepEqual(brief(results.cli), brief(results.http));
});

test("registration settings and signup have HTTP, SDK and CLI parity", async (t) => {
  const bootstrapToken = "registration-parity-bootstrap-token-long-enough";
  const input = { identifier: "customer@example.com", password: "A long customer password" };
  const enable = { enabled: true, expectedRevision: 0 };
  const settingsPath = "/auth/registration/settings";
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t, { bootstrap: { token: bootstrapToken } });
    const cli = (...args) => p.cli(runAuthCommand, args);
    const data = (value) => ["--data", JSON.stringify(value)];
    const status = {
      http: () => p.send("GET", "/auth/registration"),
      sdk: () => p.client.auth.registrationStatus(),
      cli: () => cli("registration-status"),
    }[surface];
    const settings = {
      http: () => p.send("GET", settingsPath),
      sdk: () => p.client.auth.admin.registrationSettings(),
      cli: () => cli("registration-settings"),
    }[surface];
    const set = {
      http: (value) => p.send("PUT", settingsPath, value),
      sdk: (value) => p.client.auth.admin.setRegistrationSettings(value),
      cli: (value) => cli("set-registration-settings", ...data(value)),
    }[surface];
    const signUp = {
      http: () => p.send("POST", "/auth/sign-up/password", input),
      sdk: () => p.client.auth.signUpWithPassword(input),
      cli: () => cli("sign-up", "password", ...data(input)),
    }[surface];

    assert.deepEqual(await status(), { enabled: false, providers: [] });
    assert.deepEqual(await settings(), { enabled: false, revision: 0 });
    assert.deepEqual(await set(enable), { enabled: true, revision: 1 });
    assert.deepEqual(await status(), { enabled: false, providers: [] });
    await assert.rejects(signUp(), /Registration is closed/);
    await assert.rejects(set({ enabled: false, expectedRevision: 0 }), /Registration settings have changed/);
    await p.client.auth.bootstrap({
      bootstrapToken,
      provider: "password",
      account: { username: "owner" },
      credential: { identifier: "owner", password: input.password },
    });
    assert.deepEqual(await status(), { enabled: true, providers: ["password"] });
    const result = await signUp();
    assert.deepEqual(result.account.roles, ["customer"]);
    assert.deepEqual(result.account.permissions, []);
    assert.deepEqual(result.account.grants, []);
    assert.match(result.session.token, /^zvs_/);
    assert.equal("secretHash" in result.credential, false);
    assert.equal("tokenHash" in result.session.session, false);
    await assert.rejects(signUp(), /Unable to register this identity/);
    assert.deepEqual(await set({ enabled: false, expectedRevision: 1 }), { enabled: false, revision: 2 });
    const signedIn = await p.client.auth.signInWithPassword(input);
    assert.equal(signedIn.account.id, result.account.id);
    p.as({ id: result.account.id, type: "user", roles: ["customer"], permissions: [], grants: [] });
    await assert.rejects(settings(), /Missing required permission/);
    await assert.rejects(set({ enabled: true, expectedRevision: 2 }), /Missing required permission/);
  }
});

test("public enrollment enforces body size and cannot auto-create through a login provider", async (t) => {
  let preparations = 0;
  const method = {
    name: "bounded-test",
    register(auth) {
      auth.authentication.registerProvider({
        name: "bounded-test",
        prepareCredential() { preparations++; throw new TypeError("Test input should never prepare"); },
        authenticate(input, api) { return api.accounts.create({ id: "auto", username: input.identifier }); },
      });
    },
  };
  const p = await platform(t, {
    bootstrap: { token: "registration-bounds-bootstrap-token" },
    serviceRegistry: { catalog: [{
      service: { name: "@test/bounded", kind: "plugin", capabilities: ["zelavis/identity:credentials"], service: method },
      status: "installed",
      source: "official",
    }] },
  });
  const settingsUrl = "http://localhost/zelavis/api/v1/auth/registration/settings";
  const registrationUrl = "http://localhost/zelavis/api/v1/auth/sign-up/bounded-test";
  const bootstrapPassword = "owner password for body limits";
  await p.client.auth.bootstrap({
    bootstrapToken: "registration-bounds-bootstrap-token",
    provider: "password",
    account: { username: "owner" },
    credential: { identifier: "owner", password: bootstrapPassword },
  });
  await p.client.auth.admin.setRegistrationSettings({ enabled: true, expectedRevision: 0 });
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"identifier":"one","secret":"'));
      controller.enqueue(new Uint8Array(8192).fill(65));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const oversized = await p.through(registrationUrl, {
    method: "POST", headers: { "content-type": "application/json" }, duplex: "half", body: chunks,
  });
  assert.equal(oversized.status, 413);
  assert.equal(preparations, 0);
  const malformed = await p.through(registrationUrl, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"identifier":',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_registration");
  assert.equal(preparations, 0);
  const tooBig = { enabled: true, expectedRevision: 0, extra: "x".repeat(1024) };
  assert.equal((await p.through(settingsUrl, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(tooBig),
  })).status, 413);

  const status = await p.through("http://localhost/zelavis/api/v1/auth/registration");
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await p.through(settingsUrl)).headers.get("cache-control"), "no-store");

  await assert.rejects(p.send("POST", "/auth/authenticate/bounded-test", { identifier: "auto" }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.body.code, "enrollment_required");
    return true;
  });
  assert.deepEqual((await p.client.auth.admin.accounts()).map((account) => account.username), ["owner"]);
});
