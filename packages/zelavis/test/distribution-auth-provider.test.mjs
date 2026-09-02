import assert from "node:assert/strict";
import test from "node:test";
import { emailPasswordService } from "@zelavis/app-auth-email-password";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const TOKEN = "distribution-bootstrap-token-with-32-chars";

async function platform({ withProvider = true } = {}) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: TOKEN },
    coreServices: { dashboard: false },
    // Exactly what `zelavis serve` composes through the public `authMethods`
    // option: the distribution chooses a provider, the library names none.
    authMethods: withProvider ? [emailPasswordService().service] : undefined,
  });
}

async function claimOwner(runtime, password = "correct horse battery staple") {
  return runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      bootstrapToken: TOKEN,
      provider: "email-password",
      account: { email: "owner@example.com", displayName: "Owner" },
      credential: { identifier: "owner@example.com", password },
    },
  });
}

test("a Platform with no credential provider cannot be adopted at all", async () => {
  const runtime = await platform({ withProvider: false });
  const status = await runtime.plain({ url: "/zelavis/api/v1/auth/bootstrap" });

  assert.equal(status.body.required, true);
  assert.deepEqual(status.body.enrollmentProviders, []);
  // This was the shipped behaviour: a first-owner endpoint with nothing to
  // enroll against, so the installation could never get its first account.
  const refused = await claimOwner(runtime);
  assert.equal(refused.status, 404);
  assert.match(refused.body.error, /Unknown authentication provider/);
});

test("the bundled provider makes the first owner reachable", async () => {
  const runtime = await platform();
  const status = await runtime.plain({ url: "/zelavis/api/v1/auth/bootstrap" });
  assert.deepEqual(status.body.enrollmentProviders, ["email-password"]);

  const created = await claimOwner(runtime);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.account.roles, ["owner"]);
  assert.equal(created.body.account.email, "owner@example.com");
});

test("the owner the CLI creates can sign in and is a real owner principal", async () => {
  const runtime = await platform();
  await claimOwner(runtime);

  const login = await runtime.plain({
    url: "/zelavis/api/v1/auth/authenticate/email-password",
    method: "POST",
    body: { identifier: "owner@example.com", password: "correct horse battery staple" },
  });
  assert.equal(login.status, 200);

  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { authorization: `Bearer ${login.body.session.token}` },
  });
  assert.equal(access.status, 200);
  assert.equal(access.body.mode, "owner");
  assert.equal(access.body.principal.id, login.body.account.id);
});

test("bootstrap can only be claimed once, even with the right token", async () => {
  const runtime = await platform();
  assert.equal((await claimOwner(runtime)).status, 201);

  const second = await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      bootstrapToken: TOKEN,
      provider: "email-password",
      account: { email: "intruder@example.com" },
      credential: { identifier: "intruder@example.com", password: "another password entirely" },
    },
  });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already complete/);
});

test("the owner password is never stored in a recoverable form", async () => {
  const runtime = await platform();
  const password = "correct horse battery staple";
  assert.equal((await claimOwner(runtime, password)).status, 201);

  const accounts = await runtime.plain({
    url: "/zelavis/api/v1/auth/accounts",
    headers: { origin: "http://localhost" },
  });
  assert.ok(!JSON.stringify(accounts).includes(password));
});

test("a host can offer a credential provider through the public constructor", async () => {
  // `new Zelavis(...)` refuses `coreServices` and `serviceRegistry` on purpose,
  // so `authMethods` is the only way a host composes identity. Without it the
  // public constructor could not produce an adoptable Platform at all.
  const { Zelavis } = await import("../dist/index.js");
  assert.throws(
    () => new Zelavis({ coreServices: { auth: { methods: [] } } }),
    /does not accept internal runtime options/,
  );

  const zv = new Zelavis({ authMethods: [emailPasswordService().service] });
  try {
    const status = await (
      await zv.fetch(new Request("http://localhost/zelavis/api/v1/auth/bootstrap"))
    ).json();
    assert.deepEqual(status.enrollmentProviders, ["email-password"]);
  } finally {
    await zv.close();
  }
});
