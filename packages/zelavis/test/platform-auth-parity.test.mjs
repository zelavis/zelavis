import assert from "node:assert/strict";
import test from "node:test";
import { runAuthCommand } from "../dist/cli/auth.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { platform } from "./_runtime.mjs";

const bootstrapToken = "registration-parity-bootstrap-token-32";
const password = "a secure platform parity password";
const settingsPath = "/auth/registration/settings";
const data = (value) => ["--data", JSON.stringify(value)];
const cli = (platform, ...args) => platform.cli(runAuthCommand, args);

for (const surface of ["http", "sdk", "cli"]) {
  test(`${surface}: registration closes until bootstrap and a stale setting cannot overwrite a saved revision`, async (t) => {
    const p = await platform(t, { bootstrap: { token: bootstrapToken } });
    const input = { username: "customer-parity", password, displayName: "Parity customer" };
    const settings = {
      http: () => p.send("GET", settingsPath),
      sdk: () => p.client.auth.registration.settings(),
      cli: () => cli(p, "registration", "settings"),
    }[surface];
    const set = {
      http: value => p.send("PUT", settingsPath, value),
      sdk: value => p.client.auth.registration.setSettings(value),
      cli: value => cli(p, "registration", "set-settings", ...data(value)),
    }[surface];
    const signUp = {
      http: () => p.send("POST", "/auth/username-password/sign-up", input),
      sdk: () => p.client.auth.usernamePassword.signUp(input),
      cli: () => cli(p, "username-password", "sign-up", ...data(input)),
    }[surface];
    const status = {
      http: () => p.send("GET", "/auth/registration"),
      sdk: () => p.client.auth.registration.status(),
      cli: () => cli(p, "registration", "status"),
    }[surface];

    assert.deepEqual(await status(), { enabled: false, providers: [] });
    assert.deepEqual(await settings(), { enabled: false, revision: 0 });
    assert.deepEqual(await set({ enabled: true, expectedRevision: 0 }), { enabled: true, revision: 1 });
    assert.deepEqual(await status(), { enabled: false, providers: [] });
    await assert.rejects(signUp(), /registration is closed/i);
    await assert.rejects(set({ enabled: false, expectedRevision: 0 }), /Registration settings have changed/);
    await p.client.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
    assert.deepEqual(await status(), { enabled: true, providers: ["usernamePassword", "usernamePasskey"] });
    const result = await signUp();
    assert.equal(result.status, "complete");
    const { accounts: [account] } = await p.client.auth.admin.accounts({ accountId: result.userId });
    assert.deepEqual(account.roles, ["customer"]);
    assert.deepEqual(account.permissions, []);
    assert.deepEqual(account.grants, []);
    assert.equal(account.displayName, input.displayName);
    await assert.rejects(signUp(), /username is taken/i);
    assert.deepEqual(await set({ enabled: false, expectedRevision: 1 }), { enabled: false, revision: 2 });
    await assert.rejects(signUp(), /registration is closed/i);
    const signedIn = await p.client.auth.usernamePassword.signIn(input);
    assert.equal(signedIn.userId, result.userId);
    p.as({ id: result.userId, type: "user", roles: ["customer"], permissions: [], grants: [] });
    await assert.rejects(settings(), /Missing required permission/);
    await assert.rejects(set({ enabled: true, expectedRevision: 2 }), /Missing required permission/);
  });

  test(`${surface}: conditional account access updates the account and ends its earlier sessions`, async (t) => {
    const p = await platform(t, { bootstrap: { token: bootstrapToken } });
    await p.client.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
    const { account } = await p.client.auth.admin.createAccount({ username: "target", password });
    const { tokens } = await p.client.auth.usernamePassword.signIn({ username: "target", password });
    const signedIn = createZelavisClient({ baseUrl: "http://localhost", fetch: p.through, headers: { authorization: `Bearer ${tokens.accessToken}` } });
    const input = { expectedRevision: 0, role: "operator", permissions: ["projects.list"], grants: [], roleAssignments: [] };
    const set = {
      http: () => p.send("PUT", `/auth/accounts/${account.id}/access`, input),
      sdk: () => p.client.auth.admin.setAccess(account.id, input),
      cli: () => cli(p, "admin", "set-access", account.id, ...data(input)),
    }[surface];

    assert.deepEqual(await set(), { accountId: account.id, accessRevision: 1, role: "operator", permissions: ["projects.list"], grants: [], roleAssignments: [] });
    const { accounts: [listed] } = await p.client.auth.admin.accounts({ accountId: account.id });
    assert.equal(listed.accessRevision, 1);
    assert.equal("sessionEpoch" in listed, false);
    const { events } = await p.client.auth.admin.securityEvents();
    assert.ok(events.some(event => event.type === "account.access.changed" && event.accountId === account.id));
    await assert.rejects(set(), /revision has changed/);
    // Use the runtime's real session authenticator rather than its synthetic parity-test principal.
    p.as(undefined);
    await assert.rejects(signedIn.auth.session.current(), { status: 401 });
  });
}

test("public enrollment rejects oversized or malformed bodies before account creation", async (t) => {
  const p = await platform(t, { bootstrap: { token: bootstrapToken } });
  await p.client.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
  await p.client.auth.registration.setSettings({ enabled: true, expectedRevision: 0 });
  const url = "http://localhost/zelavis/api/v1/auth/username-password/sign-up";
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"username":"test","password":"'));
      controller.enqueue(new Uint8Array(16_384).fill(65));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const oversized = await p.through(url, {
    method: "POST", headers: { "content-type": "application/json" }, duplex: "half", body: chunks,
  });
  assert.equal(oversized.status, 413);
  const malformed = await p.through(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"username":',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_request");
  assert.deepEqual((await p.client.auth.admin.accounts()).accounts.map(account => account.username), ["owner"]);
});
