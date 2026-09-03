import assert from "node:assert/strict";
import test from "node:test";
import emailPasswordProvider from "@zelavis/app-auth-email-password";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const TOKEN = "distribution-bootstrap-token-with-32-chars";

async function platform({ withProvider = true } = {}) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: TOKEN },
    // A provider reaches auth only by being installed. The distribution seeds
    // this same package into the product-services folder; here it is supplied
    // as a registry entry, which is the identical path a discovered package
    // takes once it has been loaded.
    serviceRegistry: withProvider
      ? { catalog: [{ service: emailPasswordProvider, status: "installed", source: "official" }] }
      : undefined,
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

test("credential providers cannot be handed to the public constructor", async () => {
  const { Zelavis } = await import("../dist/index.js");
  // There is no option for supplying a provider in code any more. Composition
  // options were a second way to provide a service, and the two disagreed: a
  // provider passed that way never reached the registry, so it could not be
  // listed, disabled, or updated like the same provider installed normally.
  assert.throws(
    () => new Zelavis({ subsystems: { auth: { methods: [] } } }),
    /does not accept internal runtime options/u,
  );
  assert.throws(
    () => new Zelavis({ serviceRegistry: { catalog: [] } }),
    /does not accept internal runtime options/u,
  );
});

test("the shipped provider package exports a service, not a factory", async () => {
  // An installed package is loaded, not called. Default-exporting the factory
  // gave the loader a function, which produced no service object at all — the
  // package installed cleanly and extended nothing.
  assert.equal(typeof emailPasswordProvider, "object");
  assert.equal(emailPasswordProvider.name, "@zelavis/auth-email-password");
  assert.deepEqual(emailPasswordProvider.capabilities, ["zelavis/auth:credentials"]);
  assert.equal(typeof emailPasswordProvider.service.register, "function");
});

test("a provider that names a different owner is not collected by Platform auth", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: TOKEN },
    serviceRegistry: {
      catalog: [{
        service: {
          ...emailPasswordProvider,
          name: "@acme/other-credentials",
          // Same shape, different owner. Capability ownership exists so a
          // provider written for one plugin is not collected by another.
          capabilities: ["@acme/something-else:credentials"],
        },
        status: "installed",
        source: "community",
      }],
    },
  });

  const status = await runtime.plain({ url: "/zelavis/api/v1/auth/bootstrap" });
  assert.deepEqual(status.body.enrollmentProviders, []);
});
