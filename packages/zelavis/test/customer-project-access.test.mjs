import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nodeAdapter } from "../dist/adapters/node.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { Zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { platform } from "./_runtime.mjs";

const scoped = (permission, projectId) => ({ permission, scope: { type: "project", projectId } });
const ids = (inventory) => inventory.projects.map(({ id }) => id);

test("Platform customers see only the Projects granted to their current session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-customer-access-"));
  const bootstrapToken = "customer-project-access-bootstrap-token";
  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }),
    bootstrap: { token: bootstrapToken },
  });
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({
    baseUrl: "http://localhost", fetch: through, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const anonymous = client();
  const password = "password for customer project access";
  const { session: ownerSession } = await anonymous.auth.bootstrap({
    bootstrapToken, provider: "password", account: { username: "owner" }, credential: { identifier: "owner", password },
  });
  const owner = client(ownerSession.token);
  for (const id of ["visible-app", "hidden-app"]) {
    await owner.projects.create({ id, name: id, recipeName: "@zelavis/app", start: false });
  }
  assert.deepEqual(ids(await owner.projects.list()).sort(), ["hidden-app", "visible-app"]);
  await assert.rejects(anonymous.projects.list(), { status: 401 });

  await owner.auth.admin.setRegistrationSettings({ enabled: true, expectedRevision: 0 });
  const login = { identifier: "customer@example.com", password };
  const { account, session } = await anonymous.auth.signUpWithPassword(login);
  const customer = client(session.token);
  assert.deepEqual(ids(await customer.projects.list()), []);
  const change = { expectedRevision: 0, role: "customer", permissions: [], grants: [scoped("project.view", "visible-app")] };
  await assert.rejects(owner.auth.admin.setAccountAccess(account.id, {
    ...change, grants: [scoped("project.view", "missing-app")],
  }), { status: 400 });
  await owner.auth.admin.setAccountAccess(account.id, change);
  await assert.rejects(customer.projects.list(), { status: 401 });

  const { session: signedIn } = await anonymous.auth.signInWithPassword(login);
  const granted = client(signedIn.token);
  assert.deepEqual(ids(await granted.projects.list()), ["visible-app"]);
  assert.equal((await granted.projects.get("visible-app")).id, "visible-app");
  await assert.rejects(granted.projects.get("hidden-app"), { status: 403 });
  await assert.rejects(granted.projects.start("visible-app"), { status: 403 });
  await assert.rejects(granted.projects.create({ name: "unapproved-app", recipeName: "@zelavis/app" }), { status: 403 });
  await assert.rejects(granted.auth.admin.accounts(), { status: 403 });

  const { token: listToken } = await owner.auth.admin.createServiceAccount({ name: "List all", permissions: ["projects.list"] });
  const { token: viewToken } = await owner.auth.admin.createServiceAccount({ name: "View all", permissions: ["project.view"] });
  for (const token of [listToken, viewToken]) {
    assert.deepEqual(ids(await client(token).projects.list()).sort(), ["hidden-app", "visible-app"]);
  }
  const savedFetch = globalThis.fetch;
  const savedLog = console.log;
  const output = [];
  globalThis.fetch = through;
  console.log = (...parts) => output.push(parts.join(" "));
  try {
    await runProjectsCommand(["list", "--url", "http://localhost/zelavis", "--token", signedIn.token, "--json"]);
  } finally {
    globalThis.fetch = savedFetch;
    console.log = savedLog;
  }
  assert.deepEqual(ids(JSON.parse(output.join("\n"))), ["visible-app"]);

  await owner.projects.remove("visible-app");
  assert.deepEqual(ids(await granted.projects.list()), []);
  await owner.auth.admin.setAccountAccess(account.id, { ...change, expectedRevision: 1, grants: [] });
  await assert.rejects(granted.projects.list(), { status: 401 });
  const { session: afterRevocation } = await anonymous.auth.signInWithPassword(login);
  assert.deepEqual(ids(await client(afterRevocation.token).projects.list()), []);
});

test("scoped inventory reads exact, unique IDs and omits deletion records", async (t) => {
  const reads = [];
  const p = await platform(t, {
    serviceRegistry: { catalog: [{
      service: { name: "@test/app", version: "1.0.0", kind: "app", project: { runtimeKinds: ["native"] } },
      source: "official", status: "installed", specifier: "@test/app",
    }] },
    projectRuntime: {
      name: "test",
      runtimeKinds: ["native"],
      capabilities: () => ({ statelessRuntimeReplicas: false }),
      prepare: () => undefined,
      start: () => ({ status: "running", url: "http://127.0.0.1:1" }),
      status: (id) => { reads.push(id); return { status: "stopped" }; },
      stop: () => ({ status: "stopped" }),
      destroy: () => { throw new Error("Retain the deletion record for the test"); },
      logs: () => [],
      close: () => undefined,
    },
  });
  for (const id of ["first", "second", "deleted", "hidden"]) {
    await p.client.projects.create({ id, name: id, recipeName: "@test/app", start: false });
  }
  await assert.rejects(p.client.projects.remove("deleted"), /Retain the deletion record/);
  reads.length = 0;
  p.as({
    id: "scoped", type: "user", grants: [
      scoped("project.view", "second"), scoped("*", "first"), scoped("project.view", "first"),
      scoped("project.view", "deleted"), scoped("project.view", "absent"), scoped("project.logs.read", "hidden"),
      scoped("project.view", "hidden!"), { permission: "project.view", scope: { type: "project", projectIdParam: "hidden" } },
    ],
  });
  assert.deepEqual(ids(await p.client.projects.list()), ["first", "second"]);
  assert.deepEqual(reads.sort(), ["first", "second"]);
  reads.length = 0;
  p.as({
    id: "too-many", type: "user",
    grants: Array.from({ length: 101 }, (_, index) => scoped("project.view", `project-${index}`)),
  });
  await assert.rejects(p.client.projects.list(), (error) => error.status === 400 && error.body.code === "project_grant_limit_exceeded");
  assert.deepEqual(reads, []);
});
