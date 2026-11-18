import assert from "node:assert/strict";
import test from "node:test";
import { platform } from "./_runtime.mjs";

const service = (name, capabilities = []) => ({ name, kind: "plugin", capabilities, service: {} });

test("disable refuses installed extenders, then permits dependency order", async (t) => {
  const { send } = await platform(t, { serviceRegistry: { catalog: [
    { service: service("@acme/base"), status: "installed" },
    { service: service("@acme/child", ["@acme/base:things"]), status: "installed" },
  ] } });
  await assert.rejects(send("PATCH", "/runtime/services/%40acme%2Fbase", { status: "available" }),
    (e) => e.status === 400 && /@acme\/child; disable them first/.test(e.message));
  await send("PATCH", "/runtime/services/%40acme%2Fchild", { status: "available" });
  await send("PATCH", "/runtime/services/%40acme%2Fbase", { status: "available" });
});

import { validatePluginPackageManifest } from "../dist/core/service/manifest.js";

const manifest = (permissions) => ({ name: "@acme/principal", type: "module", exports: "./index.js",
  zelavis: { kind: "plugin", namespace: "principal", ...(permissions ? { principal: { permissions } } : {}) } });

test("principal manifest validates concrete bounded distinct permission names", () => {
  for (const permissions of [["*"], ["Bad permission"], ["p".repeat(129)], Array.from({ length: 31 }, (_, i) => `p.${i}`), ["projects.create", "projects.create"], []]) {
    assert.throws(() => validatePluginPackageManifest(manifest(permissions)), /principal.permissions/);
  }
  assert.deepEqual(validatePluginPackageManifest(manifest(["projects.create"])).zelavis.principal.permissions, ["projects.create"]);
});

test("requested permissions appear in the service listing", async (t) => {
  const { send } = await platform(t, { serviceRegistry: { catalog: [
    { service: { ...service("@acme/principal"), principal: { permissions: ["projects.create"] } }, status: "available" },
  ] } });
  const listed = (await send("GET", "/runtime/services")).services.find(s => s.name === "@acme/principal");
  assert.deepEqual(listed.principal, { permissions: ["projects.create"], approved: false });
});

import { createMemorySystemStore } from "../dist/index.js";
import { decryptSecret } from "../dist/edge/acme-crypto.js";
import { loadPlatformMasterSecret } from "../dist/platform/master-secret.js";

const permissions = ["projects.create", "projects.list"];
const principalService = { ...service("@acme/principal"), principal: { permissions } };
const catalog = [{ service: principalService, status: "available", source: "community" }];
const path = "/runtime/services/%40acme%2Fprincipal";
const install = { status: "installed", approvePermissions: permissions };
const refusal = (status, code) => e => e.status === status && e.body.error === code;

async function storedToken(store) {
  const record = await store.get("zelavis.service-principals", "@acme/principal");
  return { record, token: decryptSecret(record.value.sealed, `${await loadPlatformMasterSecret(store)}\u0000service-principal:@acme/principal`) };
}

test("approval is exact, delegated, sealed, revocable and required again on reinstall", async (t) => {
  const store = createMemorySystemStore();
  const { send, as } = await platform(t, { systemStore: store, serviceRegistry: { catalog } });
  for (const approval of [undefined, [], ["projects.create"], [...permissions, "server.domains.view"], [permissions[0], permissions[0]]]) {
    await assert.rejects(send("PATCH", path, { status: "installed", approvePermissions: approval }), refusal(409, "principal_approval_required"));
  }
  as({ id: "operator", type: "user", permissions: ["system.services.manage", "projects.create"] });
  await assert.rejects(send("PATCH", path, install), refusal(403, "account_access_forbidden"));
  as({ id: "operator", type: "user", permissions: ["system.services.manage", ...permissions] });
  const result = await send("PATCH", path, { ...install, approvePermissions: [...permissions].reverse() });
  as({ id: "owner", type: "user", permissions: ["*"] });
  const { token, record } = await storedToken(store);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(record).includes(token));
  const accounts = (await send("GET", "/auth/service-accounts")).serviceAccounts;
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0].permissions, permissions);
  assert.equal(accounts[0].metadata.ownerService, "@acme/principal");
  await send("PATCH", path, { status: "available" });
  assert.equal((await send("GET", "/auth/service-accounts")).serviceAccounts.length, 0);
  assert.equal(await store.get("zelavis.service-principals", "@acme/principal"), undefined);
  await assert.rejects(send("PATCH", path, { status: "installed" }), refusal(409, "principal_approval_required"));
  await send("PATCH", path, install);
  assert.notEqual((await storedToken(store)).record.value.accountId, accounts[0].id);
});

test("eight concurrent approvals create one owned service account and one current sealed token", async (t) => {
  const store = createMemorySystemStore();
  const { send } = await platform(t, { systemStore: store, serviceRegistry: { catalog } });
  await Promise.all(Array.from({ length: 8 }, () => send("PATCH", path, install)));
  assert.equal((await send("GET", "/auth/service-accounts")).serviceAccounts.length, 1);
  assert.equal((await store.list("zelavis.service-principals")).length, 1);
  assert.deepEqual((await send("GET", "/runtime/services")).services.find(s => s.name === "@acme/principal").principal,
    { permissions, approved: true, accountId: (await storedToken(store)).record.value.accountId });
});

test("Project installs refuse Platform principal requests", async (t) => {
  const { send } = await platform(t, { role: "project", subsystems: { auth: false }, serviceRegistry: { catalog } });
  await assert.rejects(send("PATCH", path, install), refusal(409, "principal_unsupported"));
});

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { zelavis } from "../dist/index.js";
import { createMemoryServiceRegistryStore } from "../dist/platform/settings.js";
import { createLocalRuntimeServiceManifestResolver } from "../dist/adapters/_local-runtime.js";

async function packageFixture(t, sets) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-principals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {};
  for (const [version, requested] of Object.entries(sets)) {
    const dir = join(root, version);
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...manifest(requested), version }));
    await writeFile(join(dir, "index.js"), "export function register() {}\n");
    paths[version] = join(dir, "index.js");
  }
  return { paths, root };
}

const OWNER_CONTEXT = { principal: { id: "owner", type: "user", permissions: ["*"] } };
async function nativeCall(runtime, method, path, body, context = OWNER_CONTEXT) {
  const response = await runtime.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), context);
  return { status: response.status, body: await response.json() };
}

test("POST acquisition and listed updates gate the actual fetched manifest; disabled tokens fail authentication", async (t) => {
  for (const grows of [false, true]) await t.test(grows ? "expanded request" : "unchanged request", async (t) => {
    const nextPermissions = grows ? [...permissions, "server.domains.view"] : permissions;
    const { paths } = await packageFixture(t, { "1.0.0": permissions, "2.0.0": nextPermissions });
    const store = createMemorySystemStore();
    const runtime = await zelavis({ systemStore: store,
      serviceRegistry: { catalog: [{ service: { name: "@acme/principal", kind: "plugin", version: "2.0.0" },
        status: "available", specifier: "npm:@acme/principal@2.0.0" }],
        store: createMemoryServiceRegistryStore([]), manifestResolver: createLocalRuntimeServiceManifestResolver() },
      servicePackageInstaller: { install: () => Effect.die("unused"), acquire: ({ reference }) => Effect.succeed({ specifier: paths[reference.endsWith("2.0.0") ? "2.0.0" : "1.0.0"] }) },
    });
    t.after(() => runtime.close());
    const register = { packageSource: "npm:@acme/principal@1.0.0", status: "installed" };
    assert.equal((await nativeCall(runtime, "POST", "/runtime/services", register)).body.error, "principal_approval_required");
    const created = await nativeCall(runtime, "POST", "/runtime/services", { ...register, approvePermissions: permissions });
    assert.equal(created.status, 201, JSON.stringify(created));
    const { token } = await storedToken(store);
    const withToken = () => runtime.fetch(new Request("http://localhost/zelavis/api/v1/auth/service-accounts", { headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await withToken()).status, 403);
    const update = await nativeCall(runtime, "POST", `${path}/update`, {});
    assert.equal(update.status, grows ? 409 : 200, JSON.stringify(update));
    if (grows) {
      assert.deepEqual(update.body.permissions, nextPermissions);
      assert.equal((await nativeCall(runtime, "POST", `${path}/update`, { approvePermissions: nextPermissions })).status, 200);
    }
    assert.equal((await nativeCall(runtime, "PATCH", path, { status: "available" })).status, 200);
    assert.equal((await withToken()).status, 401);
  });
});

const projectDriver = () => ({ name: "fixture", runtimeKinds: ["app"], capabilities: () => ({}),
  async prepare() {}, async start() { return { status: "running" }; }, async stop() { return { status: "stopped" }; },
  async status() { return { status: "stopped" }; }, async destroy() {}, async close() {}, async logs() { return []; } });

test("core.fetch uses only the service account, strips cookies and bearer credentials, and is unavailable in a Project", async (t) => {
  const store = createMemorySystemStore();
  let fetchAsService, anonymousFetch, startup;
  const serviceWithSetup = { ...principalService, setup: async ({ core }) => {
    fetchAsService = core.fetch;
    startup = await core.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects"));
  } };
  const registryStore = createMemoryServiceRegistryStore([]);
  // Approve first; setup is mounted on the next engine, just as hosted activation reloads it.
  const first = await platform(t, { systemStore: store, serviceRegistry: { catalog: [{ service: serviceWithSetup, status: "available" }], store: registryStore } });
  await first.send("PATCH", path, install);
  await first.runtime.close();
  const runtime = await zelavis({ systemStore: store, projectRuntime: projectDriver(),
    // Even a host resolver that supplies an owner must not elevate core.fetch.
    resolvePrincipal: () => OWNER_CONTEXT.principal,
    serviceRegistry: { store: registryStore, catalog: [{ service: serviceWithSetup, status: "available" },
      { service: { name: "@zelavis/app", kind: "app", version: "1.0.0", project: { runtimeKinds: ["app"] }, service: {} }, status: "installed" },
      { service: { name: "@acme/echo", kind: "plugin", basePath: "/plugins/echo", service: {}, api: { v1: [
        { id: "echo", method: "GET", path: "/headers", handler: ({ request, principal }) => ({ body: {
          authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), principalId: principal?.id,
        } }) },
      ] } }, status: "installed" },
      { service: { ...service("@acme/anonymous"), setup: ({ core }) => { anonymousFetch = core.fetch; } }, status: "installed" }] },
  });
  t.after(() => runtime.close());
  assert.equal(startup.status, 503);
  const headers = { "content-type": "application/json", cookie: "zelavis_access=owner-cookie", authorization: "Bearer owner-credential" };
  const made = await fetchAsService(new Request("http://localhost/zelavis/api/v1/runtime/projects", { method: "POST", headers,
    body: JSON.stringify({ id: "service-created", name: "Service created", start: false }) }));
  assert.equal(made.status, 201, await made.text());
  const echo = await fetchAsService(new Request("http://localhost/zelavis/api/v1/plugins/echo/headers", { headers }));
  assert.equal(echo.status, 200);
  assert.deepEqual(await echo.json(), { authorization: null, cookie: null, principalId: (await storedToken(store)).record.value.accountId });
  const refused = await fetchAsService(new Request("http://localhost/zelavis/api/v1/runtime/cloud/scaling", { method: "PUT", headers, body: "{}" }));
  assert.equal(refused.status, 403);
  assert.equal((await anonymousFetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", { headers }))).status, 401);
  await nativeCall(runtime, "PATCH", path, { status: "available" });
  assert.equal((await fetchAsService(new Request("http://localhost/zelavis/api/v1/runtime/projects"))).status, 401);
  let projectFetch = "not mounted";
  const project = await zelavis({ role: "project", subsystems: { auth: false }, serviceRegistry: { catalog: [
    { service: { ...service("@acme/project"), setup: ({ core }) => { projectFetch = core.fetch; } }, status: "installed" },
  ] } });
  t.after(() => project.close());
  assert.equal(projectFetch, undefined);
});

import { viaSdk, viaCli } from "./_runtime.mjs";
import { runCli } from "../dist/cli/commands.js";
import { runMarketplaceCommand } from "../dist/cli/marketplace.js";

test("SDK and CLI carry repeatable explicit approval on install and update", async () => {
  const sdk = await viaSdk(async client => {
    await client.services.update("x", { status: "installed", approvePermissions: permissions });
    await client.marketplace.update("x", { approvePermissions: permissions });
  });
  const cliInstall = await viaCli(runCli, ["services", "install", "x", ...permissions.flatMap(p => ["--approve-permission", p])]);
  const cliUpdate = await viaCli(runMarketplaceCommand, ["update", "x", ...permissions.flatMap(p => ["--approve-permission", p])]);
  assert.deepEqual(cliInstall.filter(r => r.method === "PATCH"), [sdk[0]]);
  assert.deepEqual(cliUpdate, [sdk[1]]);
});

test("failed sealing and activation revoke the granted account; retries need approval and recover", async (t) => {
  for (const fault of ["seal", "activation", "registry"]) await t.test(fault, async (t) => {
    const base = createMemorySystemStore();
    let fail = true;
    const store = { ...base, set: (namespace, ...args) => {
      if (fail && fault === "seal" && namespace === "zelavis.service-principals") throw new Error("injected sealed write failure");
      return base.set(namespace, ...args);
    } };
    const registry = createMemoryServiceRegistryStore([]);
    const { send } = await platform(t, { systemStore: store, serviceRegistry: { catalog,
      store: { ...registry, compareAndSet: (...args) => fail && fault === "registry" ? false : registry.compareAndSet(...args) } },
      serviceActivation: { activate: () => { if (fail && fault === "activation") throw new Error("injected activation failure"); return { status: "active" }; } },
    });
    await assert.rejects(send("PATCH", path, install));
    assert.equal((await send("GET", "/auth/service-accounts")).serviceAccounts.length, 0);
    assert.equal(await store.get("zelavis.service-principals", "@acme/principal"), undefined);
    fail = false;
    await assert.rejects(send("PATCH", path, { status: "installed" }), refusal(409, "principal_approval_required"));
    await send("PATCH", path, install);
    assert.equal((await send("GET", "/auth/service-accounts")).serviceAccounts.length, 1);
  });
});

test("sealed records reject corruption and transplanting another service's token", async (t) => {
  const store = createMemorySystemStore();
  const { send } = await platform(t, { systemStore: store, serviceRegistry: { catalog } });
  await send("PATCH", path, install);
  const { record } = await storedToken(store);
  const { createServicePrincipals } = await import("../dist/platform/service-principals.js");
  const control = createServicePrincipals(store, await loadPlatformMasterSecret(store), undefined, false);
  await store.set("zelavis.service-principals", "@acme/other", record.value);
  await assert.rejects(Effect.runPromise(control.token("@acme/other")));
  await store.set("zelavis.service-principals", "@acme/principal", { ...record.value, permissions: ["*"] });
  await assert.rejects(Effect.runPromise(control.token("@acme/principal")));
});

test("POST registration cannot disable a dependency and revokes its principal when disabled", async (t) => {
  const { paths } = await packageFixture(t, { "1.0.0": permissions });
  const store = createMemorySystemStore();
  const { send } = await platform(t, { systemStore: store, serviceRegistry: {
    catalog: [{ service: service("@acme/child", ["@acme/principal:things"]), status: "installed" }],
    manifestResolver: createLocalRuntimeServiceManifestResolver(),
  } });
  await send("POST", "/runtime/services", { specifier: paths["1.0.0"], status: "installed", approvePermissions: permissions });
  await assert.rejects(send("POST", "/runtime/services", { specifier: paths["1.0.0"], status: "available" }),
    e => e.status === 400 && e.message.includes("@acme/child"));
  await send("PATCH", "/runtime/services/%40acme%2Fchild", { status: "available" });
  await send("POST", "/runtime/services", { specifier: paths["1.0.0"], status: "available" });
  assert.equal((await send("GET", "/auth/service-accounts")).serviceAccounts.length, 0);
  assert.equal(await store.get("zelavis.service-principals", "@acme/principal"), undefined);
});

test("CLI refusal prints the requested permissions and exits one", async (t) => {
  const { through } = await platform(t, { serviceRegistry: { catalog } });
  const realFetch = globalThis.fetch, realError = console.error, previousCode = process.exitCode, messages = [];
  globalThis.fetch = through; console.error = (...args) => messages.push(args.join(" ")); process.exitCode = undefined;
  try {
    await runCli(["services", "install", "@acme/principal", "--url", "http://localhost/zelavis"]);
    assert.equal(process.exitCode, 1);
    for (const permission of permissions) assert.ok(messages.join("\n").includes(permission));
  } finally { globalThis.fetch = realFetch; console.error = realError; process.exitCode = previousCode; }
});

test("a listed update reduces authority without fresh consent and retires a removed principal", async (t) => {
  for (const requested of [["projects.list"], undefined]) await t.test(requested ? "reduced" : "removed", async (t) => {
    const { paths } = await packageFixture(t, { "1.0.0": permissions, "2.0.0": requested });
    const store = createMemorySystemStore();
    const { send } = await platform(t, { systemStore: store,
      serviceRegistry: { catalog: [{ service: { name: "@acme/principal", kind: "plugin", version: "2.0.0" },
        status: "available", specifier: "npm:@acme/principal@2.0.0" }], manifestResolver: createLocalRuntimeServiceManifestResolver() },
      servicePackageInstaller: { install: () => Effect.die("unused"), acquire: () => Effect.succeed({ specifier: paths["2.0.0"] }) },
    });
    await send("POST", "/runtime/services", { specifier: paths["1.0.0"], status: "installed", approvePermissions: permissions });
    await send("POST", `${path}/update`, {});
    const accounts = (await send("GET", "/auth/service-accounts")).serviceAccounts;
    if (requested) assert.deepEqual(accounts[0].permissions, requested);
    else { assert.deepEqual(accounts, []); assert.equal(await store.get("zelavis.service-principals", "@acme/principal"), undefined); }
  });
});

test("registration refuses an alias before creating a principal", async (t) => {
  const { paths } = await packageFixture(t, { "1.0.0": permissions });
  const { send } = await platform(t, { serviceRegistry: { manifestResolver: createLocalRuntimeServiceManifestResolver() } });
  await assert.rejects(send("POST", "/runtime/services", { name: "@acme/alias", specifier: paths["1.0.0"], status: "installed", approvePermissions: permissions }),
    e => e.status === 400 && /match the loaded package identity/.test(e.message));
  assert.deepEqual((await send("GET", "/auth/service-accounts")).serviceAccounts, []);
});

import { openAuth } from "./_auth.mjs";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { createAdmittedAccount } from "../dist/auth/accounts/accounts.js";
import { serviceAccountTables } from "../dist/auth/serviceAccounts/tables.js";
import { grantServicePrincipal, retireServicePrincipal } from "../dist/auth/serviceAccounts/servicePrincipals.js";

test("a corrupt ownership reference cannot change or delete a foreign account", async (t) => {
  const { auth, run } = await openAuth(t);
  for (const kind of ["human", "service"]) {
    const foreignId = await run(auth.runtime.mutation({ ip: null }, tx => createAdmittedAccount(tx, {
      kind, roles: [kind === "human" ? "operator" : "service"], permissions: ["server.domains.view"], grants: [],
      metadata: { ownerService: "@acme/foreign" },
    })));
    const ownerId = await run(auth.runtime.mutation({ ip: null }, tx => tx.db.insert(serviceAccountTables.owners, { serviceName: "@acme/principal", accountId: foreignId })));
    await assert.rejects(run(auth.runtime.mutation({ ip: null }, tx => grantServicePrincipal(tx, {
      principal: OWNER_CONTEXT.principal, serviceName: "@acme/principal", title: "Principal", permissions,
    }))));
    await assert.rejects(run(auth.runtime.mutation({ ip: null }, tx => retireServicePrincipal(tx, "@acme/principal"))));
    const foreign = await run(auth.runtime.query({ ip: null }, tx => tx.db.get(accountsTables.accounts, foreignId)));
    assert.deepEqual(foreign.permissions, ["server.domains.view"]);
    await run(auth.runtime.mutation({ ip: null }, tx => tx.db.delete(serviceAccountTables.owners, ownerId)));
  }
});

test("SDK and CLI catalogue installs approve the acquired manifest rather than the advertised identity", async (t) => {
  const { paths } = await packageFixture(t, { "1.0.0": permissions });
  const registry = createMemoryServiceRegistryStore([]);
  let acquisitions = 0;
  const { send, client, through } = await platform(t, {
    serviceRegistry: { store: registry, catalog: [{ service: { name: "@acme/principal", version: "1.0.0", kind: "plugin" },
      status: "available", specifier: "npm:@acme/principal@1.0.0" }], manifestResolver: createLocalRuntimeServiceManifestResolver() },
    servicePackageInstaller: { install: () => Effect.die("unused"), acquire: () => { acquisitions++; return Effect.succeed({ specifier: paths["1.0.0"] }); } },
  });
  await assert.rejects(client.services.update("@acme/principal", { status: "installed" }), e =>
    e.status === 409 && e.body.error === "principal_approval_required" && JSON.stringify(e.body.permissions) === JSON.stringify(permissions));
  await client.services.update("@acme/principal", install);
  await send("PATCH", path, { status: "available" });
  const snapshot = await registry.readSnapshot();
  assert.equal(await registry.compareAndSet(snapshot.revision, []), true);
  const realFetch = globalThis.fetch, realLog = console.log, previousCode = process.exitCode, messages = [];
  globalThis.fetch = through; console.log = (...args) => messages.push(args.join(" ")); process.exitCode = undefined;
  try {
    await runCli(["services", "install", "@acme/principal", ...permissions.flatMap(p => ["--approve-permission", p]), "--url", "http://localhost/zelavis"]);
    assert.equal(process.exitCode ?? 0, 0);
    assert.ok(messages.some(message => message.includes("Installed @acme/principal")));
  } finally { globalThis.fetch = realFetch; console.log = realLog; process.exitCode = previousCode; }
  const installed = (await send("GET", "/runtime/services")).services.find(service => service.name === "@acme/principal");
  assert.equal(acquisitions, 3);
  assert.equal(installed.status, "installed");
  assert.deepEqual(installed.principal.permissions, permissions);
  assert.equal(installed.principal.approved, true);
});
