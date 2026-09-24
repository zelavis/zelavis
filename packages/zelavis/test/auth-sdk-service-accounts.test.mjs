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
