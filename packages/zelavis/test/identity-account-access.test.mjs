import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  bindProjectAccountAccessProof,
  decodeProjectAccountAuthority,
  projectAccountAccessDigest,
  projectAccountAccessPermissions,
} from "../dist/app/identity/domain/account-access.js";

import {
  createDatabaseAuthRepositories,
  createIdentity,
  createInMemoryAuthRepositories,
} from "../dist/app/identity/index.js";
import { createMemorySystemStore } from "../dist/index.js";
import { createPlatformAuthRepositories } from "../dist/platform/auth-repositories.js";
import { openTemporaryDatabase } from "./_database.mjs";

const owner = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] }, authority: "platform" };
const grant = (permission, projectId = "first-app") => ({ permission, scope: { type: "project", projectId } });
const change = (overrides) => ({ role: "customer", expectedRevision: 0, permissions: [], grants: [], ...overrides });
const session = (auth, accountId) => auth.sessions.create({ accountId, expiresAt: new Date(Date.now() + 60_000) });
const backends = [
  ["memory", () => createInMemoryAuthRepositories()],
  ["System Store", () => createPlatformAuthRepositories(createMemorySystemStore())],
  ["Project database", async (t) => createDatabaseAuthRepositories((await openTemporaryDatabase(t)).api)],
];

for (const [name, repositoriesFor] of backends) {
  test(`${name}: account access changes only once per revision and expires old sessions`, async (t) => {
    const auth = await createIdentity({ repositories: await repositoriesFor(t) });
    await auth.accounts.create({ id: "target", username: "target", roles: ["customer"] });
    const initial = await session(auth, "target");
    assert.equal((await auth.accounts.setAccess("target", change(), owner)).accessRevision, 0);
    assert.ok(await auth.sessions.resolveToken(initial.token));

    const changes = [
      change({ grants: [grant("project.view", "second-app"), grant("project.view"), grant("project.view")] }),
      change({ grants: [grant("project.logs.read")] }),
    ];
    const settled = await Promise.allSettled(changes.map((input) => auth.accounts.setAccess("target", input, owner)));
    const winner = settled.findIndex((result) => result.status === "fulfilled");
    assert.notEqual(winner, -1);
    const committed = settled[winner].value;
    assert.equal(settled[1 - winner].reason?._tag, "AccountAccessConflict");
    assert.equal(committed.accessRevision, 1);
    assert.equal((await auth.accounts.findById("target")).sessionEpoch, 1);
    assert.equal(await auth.sessions.resolveToken(initial.token), null);
    assert.deepEqual(committed.grants, winner === 0
      ? [grant("project.view"), grant("project.view", "second-app")]
      : [grant("project.logs.read")]);
    const renewed = await session(auth, "target");
    assert.deepEqual(await auth.accounts.setAccess("target", { ...changes[winner], expectedRevision: 1 }, owner), committed);
    assert.ok(await auth.sessions.resolveToken(renewed.token));
    await assert.rejects(auth.accounts.setAccess("target", changes[winner], owner), { _tag: "AccountAccessConflict" });
  });

  test(`${name}: access edits recheck authority and protect privileged identities`, async (t) => {
    const auth = await createIdentity({ repositories: await repositoriesFor(t) });
    await auth.accounts.create({ id: "operator", username: "operator", roles: ["operator"], permissions: ["system.users.manage"], grants: [grant("project.view")] });
    await auth.accounts.create({ id: "target", username: "target", roles: ["customer"] });
    const issued = await session(auth, "operator");
    const principal = await auth.requestAuthenticator.authenticate({
      request: new Request("https://localhost/", { headers: { authorization: `Bearer ${issued.token}` } }),
    });
    assert.equal(principal.id, "operator");
    const delegate = { ...owner, principal };

    for (const input of [
      change({ grants: [grant("project.view", "second-app")] }),
      change({ permissions: ["project.view"] }),
      change({ role: "reseller" }),
    ]) {
      await assert.rejects(auth.accounts.setAccess("target", input, delegate), { _tag: "AccountAccessForbidden" });
    }
    for (const [id, account] of [
      ["bootstrap", { roles: ["owner"] }],
      ["service", { metadata: { principalType: "service" } }],
      ["owner", { roles: ["customer"] }],
    ]) {
      await auth.accounts.create({ id, username: id, ...account });
      await assert.rejects(auth.accounts.setAccess(id, change(), owner), { _tag: "AccountAccessForbidden" });
    }
    await auth.accounts.create({ id: "pending", username: "pending" }, { registrationPending: true });
    await assert.rejects(auth.accounts.setAccess("pending", change(), owner), { _tag: "AccountNotFound" });
    assert.equal((await auth.accounts.setAccess("target", change({ grants: [grant("project.view")] }), delegate)).accessRevision, 1);

    await auth.accounts.setAccess("operator", change({ role: "operator" }), owner);
    await assert.rejects(auth.accounts.setAccess("target", change({ expectedRevision: 1 }), delegate), { _tag: "AccountAccessForbidden" });
    assert.deepEqual((await auth.accounts.findById("target")).grants, [grant("project.view")]);
  });
}

test("strict input rejects wildcards, template scope and excess entries", async () => {
  const auth = await createIdentity();
  for (const input of [
    change({ unexpected: true }),
    change({ expectedRevision: Number.MAX_SAFE_INTEGER + 1 }),
    change({ permissions: ["*"] }),
    change({ grants: [{ permission: "project.view", scope: { type: "project", projectIdParam: "projectId" } }] }),
    change({ grants: [{ permission: "project.view", scope: { type: "project", projectId: "a", projectIdParam: "projectId" } }] }),
    change({ permissions: Array(100).fill("project.view"), grants: [grant("project.view")] }),
  ]) {
    await assert.rejects(auth.accounts.setAccess("target", input, owner), { _tag: "InvalidAccountAccess" });
  }
});

test("a Project admin can delegate only held grants for its own Project", async () => {
  const auth = await createIdentity({ projectId: "first-app" });
  const context = {
    authority: "project", projectId: "first-app",
    principal: { id: "actor", type: "user", grants: [grant("project.users.manage"), grant("database.read")] },
  };
  await auth.accounts.create({ id: "target", username: "target", roles: ["user"] });
  for (const input of [
    change({ role: "customer" }),
    change({ role: "user", permissions: ["database.read"] }),
    change({ role: "user", grants: [grant("database.read", "second-app")] }),
    change({ role: "user", grants: [grant("database.write")] }),
    change({ role: "user", grants: [{ permission: "database.read", scope: { type: "system" } }] }),
  ]) {
    await assert.rejects(auth.accounts.setAccess("target", input, context), { _tag: "AccountAccessForbidden" });
  }
  const edit = change({ role: "user", grants: [grant("database.read")] });
  assert.deepEqual((await auth.accounts.setAccess("target", edit, context)).grants, edit.grants);
  const otherAdmin = { ...context, principal: { id: "other", type: "user", grants: [grant("project.users.manage")] } };
  await assert.rejects(auth.accounts.setAccess("target", change({ role: "user", expectedRevision: 1 }), otherAdmin),
    { _tag: "AccountAccessForbidden" });
});

test("queued access edits refresh a revoked administrator and bound admission", async (t) => {
  const repositories = createInMemoryAuthRepositories();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const append = repositories.securityEvents.append.bind(repositories.securityEvents);
  repositories.securityEvents.append = async (event) => {
    if (event.type === "account.access.changed" && event.accountId === "operator") {
      entered.resolve();
      await release.promise;
    }
    return append(event);
  };
  const auth = await createIdentity({ repositories });
  await auth.accounts.create({ id: "operator", username: "operator", roles: ["customer"], permissions: ["system.users.manage"] });
  await auth.accounts.create({ id: "target", username: "target", roles: ["customer"] });
  const issued = await session(auth, "operator");
  const principal = await auth.requestAuthenticator.authenticate({
    request: new Request("https://localhost/", { headers: { authorization: `Bearer ${issued.token}` } }),
  });
  const revoke = auth.accounts.setAccess("operator", change(), owner);
  await entered.promise;
  const queued = auth.accounts.setAccess("target", change({ grants: [grant("project.view")] }), { authority: "platform", principal });
  const denied = assert.rejects(queued, { _tag: "AccountAccessForbidden" });
  const accepted = Array.from({ length: 30 }, () => auth.accounts.setAccess("target", change(), owner));
  await assert.rejects(auth.accounts.setAccess("target", change(), owner), { _tag: "AccountAccessBusy" });
  release.resolve();
  await revoke;
  await denied;
  assert.equal((await Promise.all(accepted)).length, 30);
  assert.deepEqual((await auth.accounts.findById("target")).grants ?? [], []);
  assert.equal((await auth.accounts.setAccess("target", change(), owner)).accessRevision, 0, "all permits were released");
});

test("access inputs and results do not alias a queued write or its stored grants", async (t) => {
  const repositories = createInMemoryAuthRepositories();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const append = repositories.securityEvents.append.bind(repositories.securityEvents);
  repositories.securityEvents.append = async (event) => {
    if (event.accountId === "holding") { entered.resolve(); await release.promise; }
    return append(event);
  };
  const auth = await createIdentity({ repositories });
  for (const id of ["holding", "target"]) await auth.accounts.create({ id, username: id, roles: ["customer"] });
  const holding = auth.accounts.setAccess("holding", change({ permissions: ["projects.list"] }), owner);
  await entered.promise;
  const input = change({ grants: [grant("project.view")] });
  const write = auth.accounts.setAccess("target", input, owner);
  input.grants[0].scope.projectId = "changed-after-submission";
  release.resolve();
  await holding;
  const result = await write;
  assert.equal(result.grants[0].scope.projectId, "first-app");
  result.grants[0].scope.projectId = "changed-after-return";
  assert.equal((await auth.accounts.findById("target")).grants[0].scope.projectId, "first-app");
});

test("invalid or exhausted persisted revisions refuse access changes", async () => {
  const repositories = createInMemoryAuthRepositories();
  const auth = await createIdentity({ repositories });
  await auth.accounts.create({ id: "target", username: "target", roles: ["customer"] });
  for (const fields of [
    { accessRevision: -1, sessionEpoch: 0 },
    { accessRevision: 0, sessionEpoch: -1 },
    { accessRevision: Number.MAX_SAFE_INTEGER + 1, sessionEpoch: 0 },
    { accessRevision: 0, sessionEpoch: Number.MAX_SAFE_INTEGER },
  ]) {
    await repositories.accounts.mutate("target", (current) => ({ ...current, ...fields }));
    const before = await repositories.accounts.findById("target");
    await assert.rejects(auth.accounts.setAccess("target", change({ permissions: ["projects.list"] }), owner),
      { _tag: "AccountAccessConflict" });
    assert.deepEqual(await repositories.accounts.findById("target"), before);
  }
});

test("a Project delegation proof binds the target, input and existing authority", async () => {
  const auth = await createIdentity({ projectId: "first-app" });
  await auth.accounts.create({ id: "target", username: "target", roles: ["user"], permissions: ["*"] });
  await auth.accounts.create({ id: "other", username: "other", roles: ["user"] });
  const input = change({ role: "user" });
  const digest = await Effect.runPromise(projectAccountAccessDigest("target", input, ["*"]));
  const principal = { id: "actor", type: "user", grants: [grant("project.users.manage")] };
  bindProjectAccountAccessProof(principal, digest);
  const context = { authority: "project", projectId: "first-app", principal };
  await assert.rejects(auth.accounts.setAccess("other", input, context), { _tag: "AccountAccessForbidden" });
  await assert.rejects(auth.accounts.setAccess("target", { ...input, grants: [grant("database.write")] }, context),
    { _tag: "AccountAccessForbidden" });
  const forgedMetadata = {
    ...context,
    principal: { ...principal, metadata: { authority: "project-gateway", accountAccessDigest: digest } },
  };
  await assert.rejects(auth.accounts.setAccess("target", input, forgedMetadata), { _tag: "AccountAccessForbidden" });
  const result = await auth.accounts.setAccess("target", input, context);
  assert.equal(result.accessRevision, 1);
  assert.deepEqual(result.permissions, []);
  assert.deepEqual(result.grants, []);
});

test("Project delegation bounds include the current creation contract's separate arrays", () => {
  const permissions = Array.from({ length: 100 }, (_, index) => `example.current-${index}`);
  const grants = Array.from({ length: 100 }, (_, index) => grant(`example.granted-${index}`));
  const [current] = decodeProjectAccountAuthority([{ id: "target", accessRevision: 0, permissions, grants }]);
  const input = change({ role: "user", grants: Array.from({ length: 100 }, (_, index) => grant(`example.next-${index}`)) });
  assert.equal(projectAccountAccessPermissions("first-app", current, input).length, 300);
});
