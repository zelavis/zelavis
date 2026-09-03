import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { PASSWORD_PROVIDER } from "../dist/app/auth/index.js";

const TOKEN = "core-password-bootstrap-token-32-characters";

async function platform() {
  return zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: TOKEN },
  });
}

async function claimOwner(runtime, identifier, password = "correct horse battery staple") {
  return runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      bootstrapToken: TOKEN,
      provider: PASSWORD_PROVIDER,
      account: { displayName: "Owner" },
      credential: { identifier, password },
    },
  });
}

test("password sign-in needs nothing installed", async () => {
  const runtime = await platform();
  const status = await runtime.plain({ url: "/zelavis/api/v1/auth/bootstrap" });

  // This used to be a plugin the distribution copied into the product-services
  // folder on first boot, because a Platform with no credential provider can
  // never create its first owner. Something an installation cannot function
  // without is not an extension.
  assert.equal(status.status, 200);
  assert.equal(status.body.required, true);
  assert.deepEqual(status.body.enrollmentProviders, [PASSWORD_PROVIDER]);
});

test("the first owner is created and can sign in", async () => {
  const runtime = await platform();
  const created = await claimOwner(runtime, "owner@example.com");

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.account.roles, ["owner"]);
  assert.equal(created.body.account.email, "owner@example.com");

  const login = await runtime.plain({
    url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`,
    method: "POST",
    // Normalized, so the address someone typed and the one they sign in with
    // do not have to match in case.
    body: { identifier: "OWNER@Example.com", password: "correct horse battery staple" },
  });
  assert.equal(login.status, 200);

  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { authorization: `Bearer ${login.body.session.token}` },
  });
  assert.equal(access.body.mode, "owner");
});

test("a username works as well as an email address", async () => {
  const runtime = await platform();
  // One provider, not two nearly identical plugins. Which kind of identifier
  // an operator typed is decided by the value rather than by which package
  // they installed.
  const created = await claimOwner(runtime, "operator");

  assert.equal(created.status, 201);
  assert.equal(created.body.account.username, "operator");
  assert.equal(created.body.account.email, undefined);

  const login = await runtime.plain({
    url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`,
    method: "POST",
    body: { identifier: "operator", password: "correct horse battery staple" },
  });
  assert.equal(login.status, 200);
});

test("a wrong password is refused and reveals nothing about the account", async () => {
  const runtime = await platform();
  await claimOwner(runtime, "owner@example.com");

  const wrongPassword = await runtime.plain({
    url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`,
    method: "POST",
    body: { identifier: "owner@example.com", password: "not the right password" },
  });
  const unknownAccount = await runtime.plain({
    url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`,
    method: "POST",
    body: { identifier: "nobody@example.com", password: "not the right password" },
  });

  // Indistinguishable, or the endpoint enumerates accounts.
  assert.equal(wrongPassword.status, unknownAccount.status);
  assert.deepEqual(wrongPassword.body, unknownAccount.body);
});

test("bootstrap can only be claimed once", async () => {
  const runtime = await platform();
  assert.equal((await claimOwner(runtime, "owner@example.com")).status, 201);

  const second = await claimOwner(runtime, "intruder@example.com");
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already complete/u);
});

test("the password is never stored in a recoverable form", async () => {
  const runtime = await platform();
  const password = "correct horse battery staple";
  assert.equal((await claimOwner(runtime, "owner@example.com", password)).status, 201);

  const accounts = await runtime.plain({
    url: "/zelavis/api/v1/auth/accounts",
    headers: { origin: "http://localhost" },
  });
  assert.ok(!JSON.stringify(accounts).includes(password));
});
