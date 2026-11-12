// A Project reaches the Platform's lease authority with a capability that opens one Project's lease for one node and
// nothing else, minted at start from the operator's configuration.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { createMemorySystemStore } from "../dist/system-store.js";
import { mintLeaseCapability, verifyLeaseCapability } from "../dist/platform/lease-capability.js";
import { createWriterLeaseRoutes } from "../dist/platform/writer-lease-routes.js";
import { createLeaseCapabilityAuthenticator } from "../dist/platform/writer-lease-routes.js";
import { deleteProjectWriterLease, systemStoreLeaseAudit, systemStoreLeaseStore } from "../dist/platform/writer-lease-store.js";
import { projectLeaseConfiguration, projectLeaseEnvironment } from "../dist/adapters/_project-lease-environment.js";
import { leaseFromEnvironment } from "../dist/adapters/_node-project-engine.js";
import { httpLeaseStore, memoryLeaseStore, startWriter } from "../dist/db/index.js";

const SECRET = "installation-secret-0123456789";

test("a capability names a Project and a node, is bound to the installation secret, and cannot be altered", async () => {
  const token = await mintLeaseCapability(SECRET, { scope: "project-1", node: "node-a" });
  assert.deepEqual(await verifyLeaseCapability(SECRET, token), { scope: "project-1", node: "node-a" });
  assert.equal(await verifyLeaseCapability("another-secret-0123456789", token), undefined, "another installation's secret does not open it");
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify(["project-2", "node-a"])).toString("base64url");
  assert.equal(await verifyLeaseCapability(SECRET, `${forged}.${signature}`), undefined, "another Project's name does not carry the signature");
  assert.equal(await verifyLeaseCapability(SECRET, `${payload}.${signature.slice(0, -2)}AA`), undefined);
  assert.equal(await verifyLeaseCapability(SECRET, "garbage"), undefined);
  await assert.rejects(mintLeaseCapability(SECRET, { scope: "has a space", node: "node-a" }));
});

/** The Platform's capability routes in this process, as a fetch. */
const platform = (projects = new Set(["project-1", "project-2"])) => {
  const store = memoryLeaseStore();
  const kept = new Map();
  const audit = systemStoreLeaseAudit({
    list: async () => [...kept].map(([key, value]) => ({ key, value })),
    set: async (_namespace, key, value) => { kept.set(key, value); return { key, value }; },
    delete: async (_namespace, key) => kept.delete(key),
  });
  const routes = createWriterLeaseRoutes(store, audit, { secret: async () => SECRET, projectExists: async (scope) => projects.has(scope) });
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    const segments = url.pathname.split("/").filter(Boolean);
    const at = segments.indexOf("project-leases");
    const route = routes.find((entry) => entry.method === init?.method && entry.path === "/project-leases/:scope");
    if (at < 0 || route === undefined) return new Response("{}", { status: 404 });
    const response = await route.handler({
      params: { scope: decodeURIComponent(segments[at + 1]) }, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      request: new Request(url, { method: init.method, headers: init.headers }), query: url.searchParams, principal: undefined, headers: {},
    });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return { fetch, store, projects, kept };
};
const storeFor = (fetch, token) => httpLeaseStore({ apiRoot: "http://platform/zelavis/api/v1", token, route: "project-leases", fetch });
const failure = (exit) => (Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason.error).find((error) => error !== undefined) : undefined);

test("the routes open only the Project's own lease, only for its node, and only while the Project exists", async () => {
  const { fetch, projects, kept } = platform();
  const a = await mintLeaseCapability(SECRET, { scope: "project-1", node: "node-a" });
  const b = await mintLeaseCapability(SECRET, { scope: "project-1", node: "node-b" });
  const other = await mintLeaseCapability(SECRET, { scope: "project-2", node: "node-a" });
  const start = (token, owner, standby, scope = "project-1") => Effect.runPromiseExit(startWriter(storeFor(fetch, token), { scope, owner, ttlMillis: 200, standby }));

  const first = await start(a, "node-a", "node-b");
  assert.equal(first._tag, "Success");
  assert.deepEqual([first.value.owner, first.value.epoch, first.value.standby], ["node-a", 1, "node-b"]);
  assert.equal(failure(await start(other, "node-a", "node-b"))._tag, "StoreError", "another Project's capability does not open this lease");
  assert.equal(failure(await start("not-a-token", "node-a", "node-b"))._tag, "StoreError", "nor does a stranger's");
  // node-b's capability may hold it only as node-b; claiming to be node-a with it is refused by the authority.
  assert.equal(failure(await Effect.runPromiseExit(startWriter(storeFor(fetch, b), { scope: "project-1", owner: "node-a", ttlMillis: 200, standby: "node-b" })))._tag, "StoreError");

  // The standby takes over once the lease has lapsed, with its own capability, and the change is audited under the Project and node.
  await new Promise((resolve) => setTimeout(resolve, 260));
  const promoted = await start(b, "node-b", "node-a");
  assert.deepEqual([promoted._tag, promoted.value?.epoch, promoted.value?.owner], ["Success", 2, "node-b"]);
  assert.deepEqual([...kept.values()].map((entry) => entry.principal).sort(), ["project:project-1@node-a", "project:project-1@node-b"]);

  // A deleted Project's capability opens nothing.
  projects.delete("project-1");
  assert.equal(failure(await start(b, "node-b", "node-a"))._tag, "StoreError");
});

test("the Platform's configuration becomes the environment a Project is started with, all or nothing, and the Project reads it back", async () => {
  assert.equal(projectLeaseConfiguration({}), undefined);
  assert.throws(() => projectLeaseConfiguration({ ZELAVIS_PROJECT_LEASES_URL: "http://127.0.0.1:3000/zelavis/api/v1" }), /together/);
  assert.throws(() => projectLeaseConfiguration({ ZELAVIS_PROJECT_LEASES_URL: "u", ZELAVIS_PROJECT_LEASES_NODE: "n", ZELAVIS_PROJECT_LEASES_STANDBY: "s", ZELAVIS_PROJECT_LEASES_TTL_MILLIS: "5" }), /1000/);
  const configuration = projectLeaseConfiguration({
    ZELAVIS_PROJECT_LEASES_URL: "http://127.0.0.1:3000/zelavis/api/v1", ZELAVIS_PROJECT_LEASES_NODE: "node-a", ZELAVIS_PROJECT_LEASES_STANDBY: "node-b",
  });
  assert.throws(() => projectLeaseConfiguration({ ZELAVIS_PROJECT_LEASES_URL: "http://127.0.0.1:3000/zelavis", ZELAVIS_PROJECT_LEASES_NODE: "n", ZELAVIS_PROJECT_LEASES_STANDBY: "s" }), /ending in \/api\/v1/);
  assert.equal(configuration.ttlMillis, 30_000);

  const records = new Map();
  const store = {
    get: async (namespace, key) => records.get(`${namespace}/${key}`),
    set: async (namespace, key, value) => { const record = { namespace, key, value, updatedAt: new Date().toISOString() }; records.set(`${namespace}/${key}`, record); return record; },
    setIfAbsent: async (namespace, key, value) => { const found = records.get(`${namespace}/${key}`); if (found) return { created: false, record: found }; const record = { namespace, key, value, updatedAt: new Date().toISOString() }; records.set(`${namespace}/${key}`, record); return { created: true, record }; },
  };
  const environment = await projectLeaseEnvironment(configuration, store, "project-9", "writer");
  assert.deepEqual([environment.ZELAVIS_LEASE_NODE, environment.ZELAVIS_LEASE_STANDBY, environment.ZELAVIS_LEASE_ROLE, environment.ZELAVIS_LEASE_TTL_MILLIS, environment.ZELAVIS_LEASE_ENDPOINT],
    ["node-a", "node-b", "writer", "30000", "http://127.0.0.1:3000/zelavis"], "the endpoint is the Platform itself, derived from its API root");
  const standby = await projectLeaseEnvironment(configuration, store, "project-9", "standby");
  assert.deepEqual([standby.ZELAVIS_LEASE_NODE, standby.ZELAVIS_LEASE_STANDBY, standby.ZELAVIS_LEASE_ROLE], ["node-b", "node-a", "standby"], "a standby is the other node and hands back to the writer");
  const standbyLease = leaseFromEnvironment("project-9", standby);
  assert.deepEqual([standbyLease.role, standbyLease.owner, standbyLease.successor, typeof standbyLease.leaderFor], ["standby", "node-b", "node-a", "function"]);
  const lease = leaseFromEnvironment("project-9", environment);
  assert.deepEqual([lease.scope, lease.owner, lease.standby], ["project-9", "node-a", "node-b"], "the Project reads exactly what the Platform gave it");
  // The token the Platform minted is the one the authority accepts for that Project and node, under the secret the store holds.
  const secret = records.get("platform.master-secret/platform")?.value ?? [...records.values()][0].value;
  const claims = await verifyLeaseCapability(typeof secret === "string" ? secret : secret.secret ?? secret.value, environment.ZELAVIS_LEASE_TOKEN);
  assert.deepEqual(claims, { scope: "project-9", node: "node-a" });
});

test("the Project driver starts a Project with the lease environment the Platform minted for it, and without it when none is configured", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createNodeProcessProjectRuntime } = await import("../dist/adapters/_node-project-runtime.js");
  const { effectOperations } = await import("../dist/core/runtime/effect-boundary.js");
  const manifest = JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8"));
  for (const guarded of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "zv-lease-driver-"));
    let started;
    // The agent stops at the first command: what is under test is the environment the driver hands it.
    const agent = { start: async (command) => { started = command; throw new Error("stopped at the command"); } };
    const driver = createNodeProcessProjectRuntime({ directory: root, agent,
      ...(guarded ? { leaseEnvironment: async (projectId, role) => ({ ZELAVIS_LEASE_AUTHORITY: "http://platform/api", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_TOKEN: `token-for-${projectId}`, ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_ROLE: "writer", ZELAVIS_LEASE_TTL_MILLIS: "30000" }) } : {}) });
    const project = { id: "one", name: "One", runtimeKind: "native", kind: "zelavis", recipe: { name: manifest.name, version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"] } };
    try {
      await driver.prepare(project, project.recipe);
      await Effect.runPromiseExit(effectOperations(driver).start(project));
      assert.ok(started, "the driver issued its command");
      if (guarded) {
        assert.deepEqual([started.env.ZELAVIS_LEASE_NODE, started.env.ZELAVIS_LEASE_STANDBY, started.env.ZELAVIS_LEASE_TOKEN], ["node-a", "node-b", "token-for-one"]);
        const lease = leaseFromEnvironment("one", started.env);
        assert.deepEqual([lease.scope, lease.owner, lease.standby], ["one", "node-a", "node-b"], "and the Project reads back exactly that");
      } else {
        assert.equal(Object.keys(started.env).some((name) => name.startsWith("ZELAVIS_LEASE_")), false, "not lease-guarded unless configured");
      }
    } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("deleteProjectWriterLease removes the record and is idempotent", async () => {
  const store = createMemorySystemStore();
  const leases = systemStoreLeaseStore(store);
  assert.equal(await Effect.runPromise(leases.create({ partition: "p1", owner: "a", epoch: 1, expiresAt: 1, acknowledgedHead: 0 })), true);
  await deleteProjectWriterLease(store, "p1");
  await deleteProjectWriterLease(store, "p1");
  assert.equal(await Effect.runPromise(leases.read("p1")), undefined);
});

test("a Project's lease capability authenticates as that Project's follower, holding database.replicate on it alone", async () => {
  const secret = "installation-secret";
  const existing = new Set(["p1"]);
  const authenticator = createLeaseCapabilityAuthenticator({ secret: async () => secret, projectExists: async (scope) => existing.has(scope) });
  const asked = (token) => authenticator.authenticate({ request: new Request("http://platform/zelavis/api/v1/runtime/x", { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }) });

  const principal = await asked(await mintLeaseCapability(secret, { scope: "p1", node: "node-b" }));
  assert.equal(principal.id, "project-lease:p1@node-b");
  assert.equal(principal.type, "service");
  assert.deepEqual(principal.grants, [{ permission: "database.replicate", scope: { type: "project", projectId: "p1" } }]);
  assert.equal(principal.permissions, undefined, "no runtime-wide authority");

  assert.equal(await asked(await mintLeaseCapability(secret, { scope: "gone", node: "node-b" })), undefined, "a deleted Project's token is nothing");
  assert.equal(await asked(await mintLeaseCapability("another-secret", { scope: "p1", node: "node-b" })), undefined, "a forged token is nothing");
  assert.equal(await asked("not-a-token"), undefined);
  assert.equal(await asked(undefined), undefined);
});
