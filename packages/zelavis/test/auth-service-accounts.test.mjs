/**
 * Zelavis Auth, Platform service accounts (part 11): `/auth/service-accounts*` and the `zvs_` bearer tokens, over
 * HTTP. Ported from `test/auth-sdk-service-accounts.test.mjs` (the routes and token behavior; its SDK and CLI forms
 * arrive with the cut-over, part 13).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { serviceAccountTables } from "../dist/auth/serviceAccounts/tables.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { composeAuth, expectStatus } from "./_auth.mjs";

const TOKEN = "zelavis-bootstrap-token-of-at-least-32-chars";
const PASSWORD = "correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;

async function platform(t, options = {}) {
  const a = await composeAuth(t, { bootstrapped: false, bootstrapToken: TOKEN, ...options });
  const owner = await expectStatus(await a.call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD } }), 201);
  const send = (path, method, body, by = owner.tokens) => a.call(path, { method, body, headers: a.bearer(by) });
  /** Who a token is, through the authenticator: the principal, or undefined. */
  const principalOf = (token) => a.run(a.auth.authenticate(new Request("https://auth.example.test/", { headers: a.bearer(token) })));
  return { ...a, owner, send, principalOf };
}

test("a service account is created with a one-time zvs_ token that authenticates as it", async (t) => {
  const a = await platform(t);
  const created = await expectStatus(await a.send("service-accounts", "POST", {
    name: "deployer",
    permissions: ["projects.list", "projects.create"],
    grants: [{ permission: "project.runtime.manage", scope: { type: "project", projectId: "project-fluxgent" } }],
  }), 201);
  assert.match(created.token, /^zvs_[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.serviceAccount.kind, "service");
  assert.equal(created.serviceAccount.metadata.principalType, "service");
  assert.deepEqual(created.serviceAccount.permissions, ["projects.list", "projects.create"]);
  assert.equal(typeof created.session.expiresAt, "string");

  const principal = await a.principalOf(created.token);
  assert.equal(principal.id, created.serviceAccount.id);
  assert.equal(principal.type, "service");
  assert.deepEqual(principal.permissions, ["projects.list", "projects.create"]);
  assert.equal(principal.metadata.sessionId, undefined, "a service token is not a session");

  const listed = await expectStatus(await a.send("service-accounts", "GET"), 200);
  assert.deepEqual(listed.serviceAccounts.map((account) => account.id), [created.serviceAccount.id]);
  // Only the token's hash is stored.
  const stored = JSON.stringify(await a.documents(serviceAccountTables.tokens));
  assert.equal(stored.includes(created.token), false);
  assert.equal(stored.includes(created.token.slice(4)), false);
  const tampered = `${created.token.slice(0, -1)}${created.token.endsWith("A") ? "Q" : "A"}`;
  assert.equal(await a.principalOf(tampered), undefined, "a token that is not the one issued names nobody");
});

test("rotating revokes the old token and issues a new one; revoking removes the account and its tokens", async (t) => {
  const a = await platform(t);
  const created = await expectStatus(await a.send("service-accounts", "POST", { name: "worker" }), 201);
  const id = created.serviceAccount.id;
  const rotated = await expectStatus(await a.send(`service-accounts/${id}/token`, "POST", { expiresInDays: 7 }), 200);
  assert.notEqual(rotated.token, created.token);
  assert.equal(await a.principalOf(created.token), undefined, "the rotated-out token stops at once");
  assert.equal((await a.principalOf(rotated.token)).id, id);

  await expectStatus(await a.send(`service-accounts/${id}`, "DELETE"), 204);
  assert.equal(await a.principalOf(rotated.token), undefined, "a revoked service account's token is refused");
  assert.equal((await a.call("session", { headers: a.bearer(rotated.token) })).status, 401);
  assert.equal((await a.rows(serviceAccountTables.tokens)).length, 0);
  assert.equal((await expectStatus(await a.send(`service-accounts/${id}`, "DELETE"), 404)).code, "account_not_found");
  const kinds = (await a.rows(securityTables.events)).map((event) => event.kind);
  for (const kind of ["service_account.created", "service_account.token_rotated", "service_account.revoked"]) assert.ok(kinds.includes(kind), kind);
});

test("managed account session routes list and revoke service tokens", async (t) => {
  const a = await platform(t);
  const worker = await expectStatus(await a.send("service-accounts", "POST", { name: "worker" }), 201);
  const id = worker.serviceAccount.id;
  const accountSessions = `accounts/${id}/sessions`;
  const listed = await expectStatus(await a.send(accountSessions, "GET"), 200);
  assert.equal(listed.sessions[0].sessionId, worker.session.id);
  assert.equal(JSON.stringify(listed).includes(worker.token), false);
  await expectStatus(await a.send(`${accountSessions}/${worker.session.id}`, "DELETE"), 204);
  assert.equal(await a.principalOf(worker.token), undefined);
  const next = await expectStatus(await a.send(`service-accounts/${id}/token`, "POST", {}), 200);
  assert.deepEqual((await expectStatus(await a.send(accountSessions, "DELETE"), 200)).revoked, [next.session.id]);
  assert.equal(await a.principalOf(next.token), undefined);
  assert.deepEqual((await expectStatus(await a.send(accountSessions, "GET"), 200)).sessions, []);
});

test("a token is refused once it expires", async (t) => {
  const a = await platform(t);
  const created = await expectStatus(await a.send("service-accounts", "POST", { name: "short-lived", expiresInDays: 1 }), 201);
  for (const expiresInDays of [0, 3651, "soon"]) {
    assert.equal((await expectStatus(await a.send("service-accounts", "POST", { name: "x", expiresInDays }), 400)).code, "invalid_service_account");
  }
  assert.ok(await a.principalOf(created.token));
  a.clock.now += DAY - 1;
  assert.ok(await a.principalOf(created.token), "valid until its last millisecond");
  a.clock.now += 1;
  assert.equal(await a.principalOf(created.token), undefined);
});

test("a service account acts in the Tenant it was given, not one derived from its id", async (t) => {
  const a = await platform(t);
  const web = await expectStatus(await a.send("service-accounts", "POST", { name: "web", tenantId: "acme" }), 201);
  const worker = await expectStatus(await a.send("service-accounts", "POST", { name: "worker", tenantId: "acme" }), 201);
  assert.equal(web.serviceAccount.metadata.tenantId, "acme");
  assert.equal(worker.serviceAccount.metadata.tenantId, "acme");
  assert.notEqual(web.serviceAccount.id, worker.serviceAccount.id);
  const solo = await expectStatus(await a.send("service-accounts", "POST", { name: "solo" }), 201);
  assert.equal(solo.serviceAccount.metadata.tenantId, undefined);

  const renamed = await expectStatus(await a.send(`service-accounts/${web.serviceAccount.id}`, "PATCH", { tenantId: "globex" }), 200);
  assert.equal(renamed.serviceAccount.metadata.tenantId, "globex");
  assert.equal((await a.principalOf(web.token)).metadata.tenantId, "globex", "the token keeps working and acts in the new Tenant");
  for (const tenantId of ["", "a/b", "zv.reserved", 7]) {
    assert.equal((await expectStatus(await a.send(`service-accounts/${web.serviceAccount.id}`, "PATCH", { tenantId }), 400)).code, "invalid_service_account");
  }
  assert.equal((await expectStatus(await a.send(`service-accounts/${"0".repeat(32)}`, "PATCH", { tenantId: "x" }), 404)).code, "account_not_found");
  assert.equal((await expectStatus(await a.send(`service-accounts/${a.owner.userId}`, "PATCH", { tenantId: "x" }), 404)).code, "account_not_found", "a human account is not a service account");
});

test("an operator gives a service account only the access it holds itself", async (t) => {
  const a = await platform(t);
  const operator = (await expectStatus(await a.send("accounts", "POST", { username: "operator", password: PASSWORD, role: "operator" }), 201)).account;
  await expectStatus(await a.send(`accounts/${operator.id}/access`, "PUT", {
    expectedRevision: 0, role: "operator", permissions: ["system.users.manage", "projects.list"],
    grants: [{ permission: "project.data.read", scope: { type: "project", projectId: "project-fluxgent" } }], roleAssignments: [],
  }), 200);
  const tokens = (await expectStatus(await a.call("username-password/sign-in", { method: "POST", body: { username: "operator", password: PASSWORD } }), 200)).tokens;
  const as = (body) => a.send("service-accounts", "POST", body, tokens);
  await expectStatus(await as({ name: "reader", permissions: ["projects.list"], grants: [{ permission: "project.data.read", scope: { type: "project", projectId: "project-fluxgent" } }] }), 201);
  for (const body of [
    { name: "too much", permissions: ["projects.create"] },
    { name: "other project", grants: [{ permission: "project.data.read", scope: { type: "project", projectId: "another" } }] },
  ]) {
    assert.equal((await expectStatus(await as(body), 403)).code, "account_access_forbidden", body.name);
  }
  assert.equal((await expectStatus(await as({ name: "unscoped", grants: [{ permission: "project.data.read" }] }), 400)).code, "invalid_service_account");
  // The owner's service account is beyond the operator; the operator cannot rotate or revoke it.
  const owners = await expectStatus(await a.send("service-accounts", "POST", { name: "owners", permissions: ["projects.create"] }), 201);
  assert.equal((await expectStatus(await a.send(`service-accounts/${owners.serviceAccount.id}/token`, "POST", {}, tokens), 403)).code, "account_access_forbidden");
  assert.equal((await expectStatus(await a.send(`service-accounts/${owners.serviceAccount.id}`, "DELETE", undefined, tokens), 403)).code, "account_access_forbidden");
  assert.ok(await a.principalOf(owners.token));
});

test("service accounts are the Platform's: an App has no such routes", async (t) => {
  const a = await composeAuth(t, { role: "project", projectId: "first-app" });
  assert.equal((await a.call("service-accounts")).status, 404);
});
