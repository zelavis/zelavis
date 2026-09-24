import assert from "node:assert/strict";
import test from "node:test";

import { createZelavisClient, ZelavisClientHttpError } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const BOOTSTRAP_TOKEN = "auth-sdk-service-account-bootstrap-token";

function fetchThrough(runtime) {
  return (url, init) => runtime.fetch(new Request(url, init));
}

async function cli(runtime, token, args) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  const out = [];
  const errors = [];
  globalThis.fetch = fetchThrough(runtime);
  console.log = (value) => out.push(value);
  console.error = (value) => errors.push(value);
  process.exitCode = undefined;
  try {
    await runCli([
      "auth",
      "service-accounts",
      ...args,
      "--url",
      "http://localhost/zelavis",
      "--token",
      token,
      "--json",
    ]);
    return {
      exitCode: process.exitCode ?? 0,
      stdout: out.length ? JSON.parse(out.join("\n")) : undefined,
      stderr: errors.length ? JSON.parse(errors.join("\n")) : undefined,
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
}

test("the SDK signs in and manages revocable Platform service accounts", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: BOOTSTRAP_TOKEN },
  });
  const anonymous = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
  });

  const bootstrapped = await anonymous.json("/auth/bootstrap", {
    method: "POST",
    body: {
      bootstrapToken: BOOTSTRAP_TOKEN,
      provider: "password",
      account: { email: "owner@example.com" },
      credential: {
        identifier: "owner@example.com",
        password: "correct horse battery staple",
      },
    },
  });
  const signedIn = await anonymous.auth.signInWithPassword({
    identifier: "owner@example.com",
    password: "correct horse battery staple",
  });
  assert.equal(signedIn.account.id, bootstrapped.account.id);

  const owner = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
    headers: { authorization: `Bearer ${signedIn.session.token}` },
  });
  const issued = await owner.auth.admin.createServiceAccount({
    name: "Fluxgent",
    permissions: ["projects.list", "projects.create"],
    grants: [
      {
        permission: "project.runtime.manage",
        scope: { type: "project", projectId: "project-fluxgent" },
      },
    ],
    expiresInDays: 30,
  });
  assert.match(issued.token, /^zvs_/u);
  assert.equal(issued.serviceAccount.metadata.principalType, "service");
  assert.equal((await owner.auth.admin.serviceAccounts()).length, 1);

  const cliCreated = await cli(runtime, signedIn.session.token, [
    "create",
    "--name",
    "CLI client",
    "--permission",
    "projects.list",
    "--project",
    "project-fluxgent",
    "--expires-days",
    "30",
  ]);
  assert.equal(cliCreated.exitCode, 0);
  assert.match(cliCreated.stdout.token, /^zvs_/u);
  assert.equal(cliCreated.stdout.serviceAccount.permissions[0], "projects.list");
  assert.equal(cliCreated.stdout.serviceAccount.grants[0].scope.projectId, "project-fluxgent");

  const cliListed = await cli(runtime, signedIn.session.token, ["list"]);
  assert.equal(cliListed.exitCode, 0);
  assert.equal(cliListed.stdout.serviceAccounts.length, 2);

  const cliRotated = await cli(runtime, signedIn.session.token, [
    "rotate",
    cliCreated.stdout.serviceAccount.id,
    "--expires-days",
    "60",
  ]);
  assert.equal(cliRotated.exitCode, 0);
  assert.match(cliRotated.stdout.token, /^zvs_/u);
  assert.notEqual(cliRotated.stdout.token, cliCreated.stdout.token);

  const cliRevoked = await cli(runtime, signedIn.session.token, [
    "revoke",
    cliCreated.stdout.serviceAccount.id,
  ]);
  assert.equal(cliRevoked.exitCode, 0);
  assert.equal(cliRevoked.stdout.revoked, cliCreated.stdout.serviceAccount.id);

  const serviceClient = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
    headers: { authorization: `Bearer ${issued.token}` },
  });
  const access = await serviceClient.runtime.access();
  assert.equal(access.principal.type, "service");
  assert.deepEqual(access.principal.permissions, ["projects.list", "projects.create"]);

  await owner.auth.admin.revokeServiceAccount(issued.serviceAccount.id);
  await assert.rejects(
    serviceClient.runtime.access(),
    (error) => error instanceof ZelavisClientHttpError && error.status === 401,
  );

  await runtime.close();
});

test("a service account acts in the Tenant it was given, not one derived from its id", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: "named-tenant-bootstrap-token-of-sufficient-length" },
  });
  const anonymous = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
  });
  await anonymous.json("/auth/bootstrap", {
    method: "POST",
    body: {
      bootstrapToken: "named-tenant-bootstrap-token-of-sufficient-length",
      provider: "password",
      account: { email: "owner@example.com" },
      credential: { identifier: "owner@example.com", password: "correct horse battery staple" },
    },
  });
  const signedIn = await anonymous.auth.signInWithPassword({
    identifier: "owner@example.com",
    password: "correct horse battery staple",
  });
  const owner = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
    headers: { authorization: `Bearer ${signedIn.session.token}` },
  });

  // Named at creation: two credentials for one customer can share records.
  const web = await owner.auth.admin.createServiceAccount({ name: "web", tenantId: "acme" });
  const worker = await owner.auth.admin.createServiceAccount({ name: "worker", tenantId: "acme" });
  assert.equal(web.serviceAccount.metadata.tenantId, "acme");
  assert.equal(worker.serviceAccount.metadata.tenantId, "acme");
  assert.notEqual(web.serviceAccount.id, worker.serviceAccount.id);

  // Unnamed still falls back to the account's own id, which is the old shape.
  const solo = await owner.auth.admin.createServiceAccount({ name: "solo" });
  assert.equal(solo.serviceAccount.metadata.tenantId, undefined);

  // An existing account can be given a name without reissuing its credential.
  const renamed = await owner.auth.admin.setServiceAccountTenant(solo.serviceAccount.id, "globex");
  assert.equal(renamed.metadata.tenantId, "globex");
  const stillValid = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: fetchThrough(runtime),
    headers: { authorization: `Bearer ${solo.token}` },
  });
  assert.equal((await stillValid.runtime.access()).principal.metadata.tenantId, "globex");

  // An id that would be read back as a different Tenant is refused.
  await assert.rejects(
    owner.auth.admin.createServiceAccount({ name: "bad", tenantId: "acme/globex" }),
    (error) => error instanceof ZelavisClientHttpError && error.status === 400,
  );
  await assert.rejects(
    owner.auth.admin.setServiceAccountTenant(web.serviceAccount.id, "zv.global"),
    (error) => error instanceof ZelavisClientHttpError && error.status === 400,
  );

  // And the CLI reaches the same operation.
  const named = await cli(runtime, signedIn.session.token, [
    "set-tenant", worker.serviceAccount.id, "--tenant", "initech",
  ]);
  assert.equal(named.exitCode, 0);
  assert.equal(named.stdout.serviceAccount.metadata.tenantId, "initech");
});
