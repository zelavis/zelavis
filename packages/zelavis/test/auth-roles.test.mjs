/**
 * Zelavis Auth, custom roles (accounts-billing plan part 6): the role catalogue, its revision and bounds, expansion
 * into principals, delegation on definition and assignment, and the App's own catalogue.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { NO_ROLES, expandAccountAccess } from "../dist/auth/roles/expand.js";
import { rolesTables } from "../dist/auth/roles/tables.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { bindTestMethod, composeAuth, expectStatus } from "./_auth.mjs";

const TOKEN = "zelavis-bootstrap-token-of-at-least-32-chars";
const PASSWORD = "correct horse battery staple";
const grant = (permission, projectId) => ({ permission, scope: { type: "project", projectId } });
const role = (id, overrides = {}) => ({ id, title: id, permissions: [], grants: [], projectPermissions: [], expectedRevision: 0, ...overrides });
const access = (overrides = {}) => ({ role: "customer", expectedRevision: 0, permissions: [], grants: [], roleAssignments: [], ...overrides });

/** A Platform with its owner signed in, as `test/auth-admin.test.mjs` builds one. */
async function platform(t) {
  const a = await composeAuth(t, { bootstrapped: false, bootstrapToken: TOKEN });
  const owner = await expectStatus(await a.call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD } }), 201);
  const send = (path, method, body, by = owner.tokens) => a.call(path, { method, body, headers: a.bearer(by) });
  const create = async (username, accountRole) =>
    (await expectStatus(await send("accounts", "POST", { username, password: PASSWORD, ...(accountRole === undefined ? {} : { role: accountRole }) }), 201)).account;
  const signIn = async (username) =>
    (await expectStatus(await a.call("username-password/sign-in", { method: "POST", body: { username, password: PASSWORD } }), 200)).tokens;
  const catalogue = async (by) => expectStatus(await send("roles", "GET", undefined, by), 200);
  const account = async (id) => (await a.rows(accountsTables.accounts)).find((row) => row._id === id);
  return { ...a, owner, send, create, signIn, catalogue, account };
}

test("expansion adds a role's permissions, grants and Project templates, and nothing for a missing role", () => {
  const roles = new Map([["dev", { permissions: ["projects.list"], grants: [grant("project.view", "p")], projectPermissions: ["project.view", "project.domains.manage"] }]]);
  const account = { permissions: ["projects.list"], grants: [grant("project.view", "p")] };
  assert.deepEqual(expandAccountAccess(account, roles), { permissions: ["projects.list"], grants: [grant("project.view", "p")] });
  assert.deepEqual(expandAccountAccess({ ...account, roleAssignments: [{ roleId: "dev" }] }, roles).grants, [grant("project.view", "p")],
    "an assignment naming no Projects gets no Project grants");
  const expanded = expandAccountAccess({ ...account, roleAssignments: [{ roleId: "dev", projectIds: ["p", "q"] }, { roleId: "gone", projectIds: ["r"] }] }, roles);
  assert.deepEqual(expanded.permissions, ["projects.list"]);
  assert.deepEqual(expanded.grants, [
    grant("project.view", "p"), grant("project.domains.manage", "p"), grant("project.view", "q"), grant("project.domains.manage", "q"),
  ]);
  assert.deepEqual(expandAccountAccess({ ...account, roleAssignments: [{ roleId: "dev", projectIds: ["p"] }] }, NO_ROLES), account);
});

test("concurrent role changes against one revision commit once", async (t) => {
  const a = await platform(t);
  const answers = await Promise.all(Array.from({ length: 16 }, (_, index) => a.send("roles", "POST", role(`role-${index}`))));
  const statuses = answers.map((answer) => answer.status).sort();
  assert.deepEqual(statuses, [201, ...Array(15).fill(409)]);
  for (const answer of answers.filter((answer) => answer.status === 409)) assert.equal((await answer.json()).code, "role_revision_conflict");
  const view = await a.catalogue();
  assert.equal(view.revision, 1);
  assert.equal(view.roles.length, 1);
});

test("the catalogue refuses reserved ids, stale revisions, duplicates and a 51st role", async (t) => {
  const a = await platform(t);
  for (const id of ["owner", "customer", "user", "system"]) {
    assert.equal((await expectStatus(await a.send("roles", "POST", role(id)), 400)).code, "invalid_role", id);
  }
  assert.equal((await expectStatus(await a.send("roles", "POST", role("Bad Id")), 400)).code, "invalid_role");
  assert.equal((await expectStatus(await a.send("roles", "POST", { ...role("extra"), unknown: true }), 400)).code, "invalid_role");
  const created = await expectStatus(await a.send("roles", "POST", role("dev", { permissions: ["projects.list", "projects.list"] })), 201);
  assert.deepEqual(created.roles.map(({ id, permissions }) => ({ id, permissions })), [{ id: "dev", permissions: ["projects.list"] }]);
  assert.equal((await expectStatus(await a.send("roles", "POST", role("again")), 409)).code, "role_revision_conflict");
  assert.equal((await expectStatus(await a.send("roles", "POST", role("dev", { expectedRevision: 1 })), 409)).code, "role_exists");
  assert.equal((await expectStatus(await a.send("roles/dev", "PUT", role("other", { expectedRevision: 1 })), 400)).code, "invalid_role");
  assert.equal((await expectStatus(await a.send("roles/missing", "PUT", role("missing", { expectedRevision: 1 })), 404)).code, "role_not_found");
  assert.equal((await expectStatus(await a.send("roles/dev", "DELETE"), 400)).code, "invalid_role", "a deletion names its revision");
  let revision = 1;
  for (let index = 1; index < 50; index += 1) {
    revision = (await expectStatus(await a.send("roles", "POST", role(`r-${index}`, { expectedRevision: revision })), 201)).revision;
  }
  assert.equal((await expectStatus(await a.send("roles", "POST", role("r-50", { expectedRevision: revision })), 429)).code, "role_limit");
  const too = role("big", { expectedRevision: revision, permissions: Array.from({ length: 60 }, (_, i) => `p.a${i}`), projectPermissions: Array.from({ length: 41 }, (_, i) => `p.b${i}`) });
  assert.equal((await expectStatus(await a.send(`roles/r-1`, "PUT", { ...too, id: "r-1" }), 400)).code, "invalid_role", "a role holds at most 100 entries");
});

test("a role change reaches its members on their next request without touching their accounts", async (t) => {
  const a = await platform(t);
  const member = await a.create("member");
  await expectStatus(await a.send("roles", "POST", role("admins", { permissions: ["system.users.manage"] })), 201);
  const assigned = await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ roleAssignments: [{ roleId: "admins" }] })), 200);
  assert.deepEqual(assigned.roleAssignments, [{ roleId: "admins" }]);
  const tokens = await a.signIn("member");
  await expectStatus(await a.send("accounts", "GET", undefined, tokens), 200);
  const before = await a.account(member.id);

  await expectStatus(await a.send("roles/admins", "PUT", role("admins", { expectedRevision: 1, permissions: ["projects.list"] })), 200);
  assert.equal((await a.send("accounts", "GET", undefined, tokens)).status, 403, "the member lost the permission on its next request");
  assert.deepEqual(await a.account(member.id), before, "the account row is untouched");

  await expectStatus(await a.send("roles/admins", "PUT", role("admins", { expectedRevision: 2, permissions: ["system.users.manage"] })), 200);
  await expectStatus(await a.send("accounts", "GET", undefined, tokens), 200);
  const deleted = await expectStatus(await a.send("roles/admins?revision=3", "DELETE"), 200);
  assert.deepEqual(deleted, { revision: 4, roles: [] });
  assert.equal((await a.send("accounts", "GET", undefined, tokens)).status, 403, "deleting the role takes its authority away");
  assert.deepEqual(await a.account(member.id), before);

  // The next access edit drops the dangling assignment; a new assignment must name a role that exists.
  assert.equal((await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ expectedRevision: 1, roleAssignments: [{ roleId: "absent" }] })), 404)).code, "role_not_found");
  const dropped = await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ expectedRevision: 1, roleAssignments: [{ roleId: "admins" }] })), 200);
  assert.deepEqual(dropped.roleAssignments, []);
  assert.deepEqual((await a.account(member.id)).roleAssignments, []);
});

test("nobody defines, changes or assigns a role holding authority they could not give directly", async (t) => {
  const a = await platform(t);
  const operator = await a.create("operator", "operator");
  await expectStatus(await a.send(`accounts/${operator.id}/access`, "PUT", access({
    role: "operator", permissions: ["system.roles.manage", "system.users.manage", "project.view"],
  })), 200);
  const customer = await a.create("customer");
  const tokens = await a.signIn("operator");
  const as = (path, method, body) => a.send(path, method, body, tokens);

  const forbidden = async (answer) => assert.equal((await expectStatus(await answer, 403)).code, "account_access_forbidden");
  await forbidden(as("roles", "POST", role("domains", { projectPermissions: ["project.domains.manage"] })));
  await forbidden(as("roles", "POST", role("grants", { grants: [grant("project.domains.manage", "p")] })));
  const viewer = await expectStatus(await as("roles", "POST", role("viewer", { projectPermissions: ["project.view"] })), 201);
  await forbidden(as("roles/viewer", "PUT", role("viewer", { expectedRevision: viewer.revision, projectPermissions: ["project.view", "project.domains.manage"] })));

  // The owner defines one the operator cannot give: the operator can neither assign it nor edit it.
  const owned = await expectStatus(await a.send("roles", "POST", role("domains", { expectedRevision: 1, projectPermissions: ["project.domains.manage"] })), 201);
  await forbidden(as(`accounts/${customer.id}/access`, "PUT", access({ roleAssignments: [{ roleId: "domains", projectIds: ["p"] }] })));
  await forbidden(as("roles/domains", "PUT", role("domains", { expectedRevision: owned.revision, projectPermissions: [] })));
  // Assigning the role it can give works, and makes the customer someone the operator can still manage.
  await expectStatus(await as(`accounts/${customer.id}/access`, "PUT", access({ roleAssignments: [{ roleId: "viewer", projectIds: ["p"] }] })), 200);
  // Once the owner assigns `domains`, the customer holds more than the operator could give and is out of its reach.
  await expectStatus(await a.send(`accounts/${customer.id}/access`, "PUT", access({ expectedRevision: 1, roleAssignments: [{ roleId: "domains", projectIds: ["p"] }] })), 200);
  await forbidden(as(`accounts/${customer.id}/access`, "PUT", access({ expectedRevision: 2 })));
  // Deleting takes authority away and needs only the right to manage roles.
  await expectStatus(await as(`roles/domains?revision=${owned.revision}`, "DELETE"), 200);
  // An administrator without system.roles.manage may read the catalogue to assign roles, never change it.
  const assigner = await a.create("assigner", "operator");
  await expectStatus(await a.send(`accounts/${assigner.id}/access`, "PUT", access({ role: "operator", permissions: ["system.users.manage"] })), 200);
  const assignerTokens = await a.signIn("assigner");
  assert.equal((await a.catalogue(assignerTokens)).roles.length, 1);
  assert.equal((await a.send("roles", "POST", role("more", { expectedRevision: 4 }), assignerTokens)).status, 403);
  const plain = await a.signIn("customer");
  assert.equal((await a.send("roles", "GET", undefined, plain)).status, 403);
});

test("an account's access may expand to at most 2000 permissions and grants", async (t) => {
  const a = await platform(t);
  const member = await a.create("member");
  let revision = 0;
  for (let index = 0; index < 10; index += 1) {
    revision = (await expectStatus(await a.send("roles", "POST", role(`wide-${index}`, {
      expectedRevision: revision, projectPermissions: Array.from({ length: 100 }, (_, i) => `wide.p${i}`),
    })), 201)).revision;
  }
  const projects = Array.from({ length: 20 }, (_, i) => `project-${i}`);
  const all = Array.from({ length: 10 }, (_, index) => ({ roleId: `wide-${index}`, projectIds: projects }));
  assert.equal((await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ roleAssignments: all })), 400)).code, "role_expansion_limit");
  await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ roleAssignments: all.slice(0, 1) })), 200);
  assert.equal((await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ roleAssignments: Array.from({ length: 11 }, (_, i) => ({ roleId: `r-${i}` })) })), 400)).code,
    "invalid_account_access", "at most 10 assignments");
});

test("a stored role that does not decode grants nothing and closes role administration", async (t) => {
  const a = await platform(t);
  const member = await a.create("member");
  await expectStatus(await a.send("roles", "POST", role("admins", { permissions: ["system.users.manage"] })), 201);
  await expectStatus(await a.send(`accounts/${member.id}/access`, "PUT", access({ roleAssignments: [{ roleId: "admins" }] })), 200);
  const [row] = await a.rows(rolesTables.roles);
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(rolesTables.roles, row._id, { definition: { title: 7 } })));
  // Nobody holding an assignment has signed in yet, so the in-process copy is loaded from the corrupted row.
  const tokens = await a.signIn("member");
  const principal = await a.run(a.auth.authenticate(new Request("https://auth.example.test/", { headers: a.bearer(tokens) })));
  assert.deepEqual(principal.permissions, [], "the unreadable role grants nothing");
  const listed = await a.send("roles", "GET");
  assert.equal(listed.status, 503);
  assert.equal((await listed.json()).code, "roles_unavailable");
  assert.equal((await a.send("roles", "POST", role("more", { expectedRevision: 1 }))).status, 503);
  assert.ok(a.logs.some(({ text }) => text.includes(`roles_roles row ${row._id} does not decode`)), "one log line names the row");
  assert.ok(!a.logs.some(({ text }) => text.includes("system.users.manage")), "the log names no content");
  assert.equal((await a.send("accounts", "GET", undefined, tokens)).status, 403, "the unreadable role grants nothing");
});

test("an App's roles hold permissions on the App's own Project", async (t) => {
  const a = await composeAuth(t, { role: "project", projectId: "first-app" });
  const method = bindTestMethod(a.auth);
  const admin = await a.run(method.signUp({}));
  const member = await a.run(method.signUp({}));
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, admin.userId, {
    grants: [grant("project.users.manage", "first-app"), grant("database.read", "first-app")],
  })));
  const send = (path, httpMethod, body, by = admin) => a.call(path, { method: httpMethod, body, headers: a.bearer(by) });
  assert.equal((await expectStatus(await send("roles", "POST", role("bad", { projectPermissions: ["database.read"] })), 400)).code, "invalid_role");
  assert.equal((await expectStatus(await send("roles", "POST", role("bad", { grants: [grant("database.read", "first-app")] })), 400)).code, "invalid_role");
  assert.equal((await expectStatus(await send("roles", "POST", role("writer", { permissions: ["database.write"] })), 403)).code, "account_access_forbidden");
  await expectStatus(await send("roles", "POST", role("reader", { permissions: ["database.read"] })), 201);
  const edit = (input) => send(`accounts/${member.userId}/access`, "PUT", { ...access({ role: "user" }), ...input });
  assert.equal((await expectStatus(await edit({ roleAssignments: [{ roleId: "reader", projectIds: ["first-app"] }] }), 403)).code, "account_access_forbidden",
    "an App assignment names no Projects");
  await expectStatus(await edit({ roleAssignments: [{ roleId: "reader" }] }), 200);
  const tokens = await a.run(method.signIn(member.userId));
  const principal = await a.run(a.auth.authenticate(new Request("https://auth.example.test/", { headers: a.bearer(tokens) })));
  assert.equal(principal.permissions, undefined);
  assert.deepEqual(principal.grants, [grant("database.read", "first-app")]);
});

// --- On a Platform and through the Project Gateway ------------------------

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeAdapter } from "../dist/adapters/node.js";
import { runAuthOperations } from "../dist/cli/auth-operations.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { Zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

/** Runs a CLI entry against `through` and answers its `--json` output. */
async function cliJson(run, args, origin, through) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines = [];
  globalThis.fetch = (request, init) => new URL(request instanceof Request ? request.url : String(request)).origin === origin
    ? through(request, init) : originalFetch(request, init);
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await run([...args, "--url", `${origin}/zelavis`, "--json"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  return JSON.parse(lines.join("\n"));
}

test("a Platform role gives a customer exactly its assigned Projects, and edits and deletion reach the next request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-roles-"));
  const bootstrapToken = "custom-roles-platform-bootstrap-token";
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }), bootstrap: { token: bootstrapToken } });
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const origin = "http://roles-platform.test";
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({ baseUrl: origin, fetch: through, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const password = "password for custom role assignments";
  const anonymous = client();
  const owner = client((await anonymous.auth.bootstrap.claim({ bootstrapToken, username: "owner", password })).tokens.accessToken);
  for (const id of ["p", "q", "r"]) await owner.projects.create({ id, name: id, recipeName: "@zelavis/app", start: false });
  await owner.auth.registration.setSettings({ enabled: true, expectedRevision: 0 });
  const login = { username: "customer", password };
  const { userId } = await anonymous.auth.usernamePassword.signUp(login);

  const developer = { id: "project-developer", title: "Project developer", permissions: [], grants: [], projectPermissions: ["project.view", "project.domains.manage"] };
  const created = await owner.auth.admin.createRole({ ...developer, expectedRevision: 0 });
  assert.equal(created.revision, 1);
  assert.deepEqual(await cliJson(runAuthOperations, ["roles", "--token", (await anonymous.auth.usernamePassword.signIn({ username: "owner", password })).tokens.accessToken], origin, through), created,
    "the CLI answers what the SDK does");
  const access = { expectedRevision: 0, role: "customer", permissions: [], grants: [], roleAssignments: [{ roleId: "project-developer", projectIds: ["p", "missing"] }] };
  await assert.rejects(owner.auth.admin.setAccess(userId, access), { status: 400 }, "assignments name existing Projects");
  const assigned = await owner.auth.admin.setAccess(userId, { ...access, roleAssignments: [{ roleId: "project-developer", projectIds: ["q", "p"] }] });
  assert.deepEqual(assigned.roleAssignments, [{ roleId: "project-developer", projectIds: ["p", "q"] }]);

  const customer = client((await anonymous.auth.usernamePassword.signIn(login)).tokens.accessToken);
  assert.deepEqual((await customer.projects.list()).projects.map(({ id }) => id).sort(), ["p", "q"]);
  await customer.projects.addDomain("p", { hostname: "p.roles.example", tlsMode: "external" });
  await assert.rejects(customer.projects.addDomain("r", { hostname: "r.roles.example", tlsMode: "external" }), { status: 403 });
  const before = (await owner.auth.admin.accounts({ accountId: userId })).accounts[0].accessRevision;

  await owner.auth.admin.updateRole("project-developer", { ...developer, projectPermissions: ["project.view"], expectedRevision: 1 });
  await assert.rejects(customer.projects.addDomain("q", { hostname: "q.roles.example", tlsMode: "external" }), { status: 403 });
  assert.deepEqual((await customer.projects.list()).projects.map(({ id }) => id).sort(), ["p", "q"]);
  assert.equal((await owner.auth.admin.accounts({ accountId: userId })).accounts[0].accessRevision, before, "the account was not touched");

  await owner.auth.admin.deleteRole("project-developer", 2);
  assert.deepEqual((await customer.projects.list()).projects, [], "deleting the role takes its Projects away");
});

test("an App's roles are managed through the exact Gateway routes and give App users authority on that App", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-app-roles-"));
  const bootstrapToken = "custom-roles-app-bootstrap-token";
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }), bootstrap: { token: bootstrapToken } });
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const origin = "http://roles-app-platform.test";
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({ baseUrl: origin, fetch: through, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const password = "password for App custom roles";
  const owner = client((await client().auth.bootstrap.claim({ bootstrapToken, username: "owner", password })).tokens.accessToken);
  const project = await owner.projects.create({ id: "roles-app", name: "App", recipeName: "@zelavis/app" });
  await owner.projects.create({ id: "other-app", name: "Other", recipeName: "@zelavis/app", start: false });
  await owner.projects.setRegistrationSettings(project.id, { enabled: true, expectedRevision: 0 });
  const app = createZelavisClient({ baseUrl: project.runtime.url });
  const { userId } = await app.auth.usernamePassword.signUp({ username: "person", password });
  const scoped = (permission, projectId = project.id) => ({ permission, scope: { type: "project", projectId } });
  const reader = { id: "reader", title: "Reader", permissions: ["database.read"], grants: [], projectPermissions: [] };

  await assert.rejects(owner.projects.createRole(project.id, { ...reader, projectPermissions: ["database.read"], expectedRevision: 0 }), { status: 400 });
  const { token: otherToken } = await owner.auth.serviceAccounts.create({ name: "Other delegate", grants: [scoped("project.users.manage", "other-app"), scoped("database.read", "other-app")] });
  await assert.rejects(client(otherToken).projects.roles(project.id), { status: 403 }, "authority on another Project manages none of this App's roles");
  const { token: delegateToken } = await owner.auth.serviceAccounts.create({ name: "Delegate", grants: [scoped("project.users.manage"), scoped("example.access")] });
  const delegate = client(delegateToken);
  await assert.rejects(delegate.projects.createRole(project.id, { ...reader, expectedRevision: 0 }), { status: 403 }, "the delegate does not hold database.read");
  const helper = await delegate.projects.createRole(project.id, { id: "helper", title: "Helper", permissions: ["example.access"], grants: [], projectPermissions: [], expectedRevision: 0 });
  assert.deepEqual(helper.roles.map(({ id }) => id), ["helper"]);
  const cliView = await cliJson(runProjectsCommand, ["roles", project.id, "--token", delegateToken], origin, through);
  assert.deepEqual(cliView, await delegate.projects.roles(project.id));

  const withReader = await owner.projects.createRole(project.id, { ...reader, expectedRevision: helper.revision });
  await assert.rejects(delegate.projects.setAccountAccess(project.id, userId, {
    expectedRevision: 0, role: "user", permissions: [], grants: [], roleAssignments: [{ roleId: "reader" }],
  }), { status: 403 }, "the delegate cannot assign a role holding database.read");
  await assert.rejects(owner.projects.setAccountAccess(project.id, userId, {
    expectedRevision: 0, role: "user", permissions: [], grants: [], roleAssignments: [{ roleId: "reader", projectIds: [project.id] }],
  }), { status: 403 }, "App assignments name no Projects");
  await owner.projects.setAccountAccess(project.id, userId, { expectedRevision: 0, role: "user", permissions: [], grants: [], roleAssignments: [{ roleId: "reader" }] });
  const signedIn = createZelavisClient({ baseUrl: project.runtime.url, headers: { authorization: `Bearer ${(await app.auth.usernamePassword.signIn({ username: "person", password })).tokens.accessToken}` } });
  const principal = (await signedIn.runtime.access()).principal;
  assert.deepEqual(principal.grants, [scoped("database.read")]);

  await assert.rejects(delegate.projects.updateRole(project.id, "reader", { ...reader, permissions: ["example.access"], expectedRevision: withReader.revision }), { status: 403 },
    "a change must be delegable as the role was");
  await owner.projects.updateRole(project.id, "reader", { ...reader, permissions: ["database.write"], expectedRevision: withReader.revision });
  assert.deepEqual((await signedIn.runtime.access()).principal.grants, [scoped("database.write")], "the next request carries the edited role");
  const deleted = await delegate.projects.deleteRole(project.id, "reader", withReader.revision + 1);
  assert.deepEqual(deleted.roles.map(({ id }) => id), ["helper"]);
  assert.deepEqual((await signedIn.runtime.access()).principal.grants, []);
  const proxied = await owner.request(`/runtime/projects/${project.id}/proxy/zelavis/api/v1/auth/roles`, { method: "POST", body: { ...reader, expectedRevision: deleted.revision } });
  assert.equal(proxied.status, 403, "the ordinary proxy carries no role authority");
});
