import assert from "node:assert/strict";
import test from "node:test";
import {
  activateServiceRegistry,
  addDomainBinding,
  createInMemoryBundleStore,
  createInMemoryDomainBindingStore,
  createKeyValueDomainBindingStore,
  deleteProjectDomainBindings,
  generateVerificationToken,
  listAuthorizedHostsForService,
  revokeDomainBindingVerification,
  verifyDomainBindingManually,
} from "../dist/index.js";
import { createServiceRuntime } from "../dist/core/index.js";

const utf8 = (text) => new TextEncoder().encode(text);

// ---------- Token generation ----------

test("generateVerificationToken produces URL-safe random tokens", () => {
  const a = generateVerificationToken();
  const b = generateVerificationToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, `expected length >= 32, got ${a.length}`);
  // URL-safe: no `+`, `/`, or `=`.
  assert.ok(!/[+/=]/.test(a), `token contains URL-unsafe char: ${a}`);
});

test("generateVerificationToken honors a custom byte length", () => {
  const small = generateVerificationToken(8);
  const large = generateVerificationToken(64);
  // Base64 expands roughly 4:3, so byte counts produce predictable
  // string lengths within ±2 chars.
  assert.ok(small.length < large.length);
  assert.ok(small.length >= 10 && small.length <= 14);
});

// ---------- In-memory store CRUD ----------

test("in-memory store stores and retrieves bindings (case-insensitive)", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, {
    host: "ACME.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });

  assert.equal(binding.host, "acme.com");
  assert.equal(binding.projectId, "ws-1");
  assert.equal(binding.serviceName, "@example/kanban");
  assert.equal(binding.verifiedAt, undefined);
  assert.ok(binding.verificationToken.length > 0);

  // Case-insensitive lookup.
  const fetched = await store.get("ACME.COM");
  assert.deepEqual(fetched, binding);
});

test("in-memory store rejects duplicate inserts but allows explicit upsert", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });

  await assert.rejects(
    () => addDomainBinding(store, { host: "acme.com" }),
    /already exists/,
  );

  // Upsert via put with mode "upsert" succeeds.
  const updated = await store.put(
    {
      host: "acme.com",
      verificationToken: "t",
      createdAt: "now",
      updatedAt: "now",
    },
    "upsert",
  );
  assert.equal(updated.verificationToken, "t");
});

test("in-memory store list filters by workspace, service, and verified status", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "a.example.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });
  await addDomainBinding(store, {
    host: "b.example.com",
    projectId: "ws-1",
    serviceName: "@example/billing",
  });
  await addDomainBinding(store, {
    host: "c.example.com",
    projectId: "ws-2",
    serviceName: "@example/kanban",
  });
  await verifyDomainBindingManually(store, "a.example.com");

  // All
  assert.equal((await store.list()).length, 3);
  // By workspace
  const ws1 = await store.list({ projectId: "ws-1" });
  assert.deepEqual(
    ws1.map((b) => b.host),
    ["a.example.com", "b.example.com"],
  );
  // By service
  const kanban = await store.list({ serviceName: "@example/kanban" });
  assert.deepEqual(
    kanban.map((b) => b.host),
    ["a.example.com", "c.example.com"],
  );
  // Verified only
  const verified = await store.list({ verifiedOnly: true });
  assert.deepEqual(
    verified.map((b) => b.host),
    ["a.example.com"],
  );
});

test("in-memory store delete returns true/false based on whether anything was removed", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });
  assert.equal(await store.delete("ACME.COM"), true);
  assert.equal(await store.delete("acme.com"), false);
  assert.equal(await store.get("acme.com"), undefined);
});

test("Project domain cleanup removes only bindings owned by that Project", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "alpha.example.com",
    projectId: "alpha",
  });
  await addDomainBinding(store, {
    host: "alpha-service.example.com",
    projectId: "alpha",
    serviceName: "@example/storefront",
  });
  await addDomainBinding(store, {
    host: "beta.example.com",
    projectId: "beta",
  });
  await addDomainBinding(store, { host: "platform.example.com" });

  assert.equal(await deleteProjectDomainBindings(store, "alpha"), 2);
  assert.deepEqual(
    (await store.list()).map((binding) => binding.host),
    ["beta.example.com", "platform.example.com"],
  );
  assert.equal(await deleteProjectDomainBindings(store, "alpha"), 0);
});

test("in-memory store accepts a seed at construction", async () => {
  const seed = [
    {
      host: "seeded.com",
      verificationToken: "tok",
      verifiedAt: "2026-01-01T00:00:00Z",
      verificationMethod: "manual",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const store = createInMemoryDomainBindingStore(seed);
  const fetched = await store.get("seeded.com");
  assert.ok(fetched);
  assert.equal(fetched.verifiedAt, "2026-01-01T00:00:00Z");
});

// ---------- Verification helpers ----------

test("verifyDomainBindingManually sets verifiedAt + method", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });

  const verified = await verifyDomainBindingManually(store, "acme.com");
  assert.ok(verified.verifiedAt, "verifiedAt should be set");
  assert.equal(verified.verificationMethod, "manual");
  // updatedAt is always touched on mutation; for tests we just check
  // it's an ISO string (millisecond ties between create and verify
  // calls aren't worth asserting against).
  assert.ok(verified.updatedAt, "updatedAt should be present");
  assert.match(verified.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("verifyDomainBindingManually throws when the host has no binding", async () => {
  const store = createInMemoryDomainBindingStore();
  await assert.rejects(
    () => verifyDomainBindingManually(store, "unknown.com"),
    /No domain binding exists/,
  );
});

test("revokeDomainBindingVerification clears verifiedAt and method but keeps the binding", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });
  await verifyDomainBindingManually(store, "acme.com");

  const revoked = await revokeDomainBindingVerification(store, "acme.com");
  assert.ok(revoked);
  assert.equal(revoked.verifiedAt, undefined);
  assert.equal(revoked.verificationMethod, undefined);

  // Token survives for re-verification
  const stored = await store.get("acme.com");
  assert.ok(stored.verificationToken.length > 0);
});

test("revokeDomainBindingVerification returns undefined for unknown host (no-op)", async () => {
  const store = createInMemoryDomainBindingStore();
  const result = await revokeDomainBindingVerification(store, "unknown.com");
  assert.equal(result, undefined);
});

// ---------- KV-backed store ----------

function createMemoryKv() {
  const data = new Map();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      return data.delete(key);
    },
    async list(prefix) {
      const out = [];
      for (const key of data.keys()) {
        if (!prefix || key.startsWith(prefix)) {
          out.push(key);
        }
      }
      return out;
    },
  };
}

test("KV store round-trips bindings with the same semantics as the in-memory store", async () => {
  const kv = createMemoryKv();
  const store = createKeyValueDomainBindingStore({ store: kv });

  await addDomainBinding(store, {
    host: "acme.com",
    projectId: "ws-1",
  });
  await verifyDomainBindingManually(store, "acme.com");

  const fetched = await store.get("acme.com");
  assert.ok(fetched);
  assert.equal(fetched.projectId, "ws-1");
  assert.ok(fetched.verifiedAt);

  // Stored as JSON under the expected key prefix.
  const raw = await kv.get("domain-bindings/acme.com");
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.host, "acme.com");
});

test("KV store delete + list honor the prefix", async () => {
  const kv = createMemoryKv();
  await kv.set("unrelated/key", "x");
  const store = createKeyValueDomainBindingStore({ store: kv });

  await addDomainBinding(store, { host: "a.com" });
  await addDomainBinding(store, { host: "b.com" });

  const listed = await store.list();
  assert.deepEqual(
    listed.map((b) => b.host),
    ["a.com", "b.com"],
  );

  await store.delete("a.com");
  assert.equal(await store.get("a.com"), undefined);
  assert.equal(await kv.get("unrelated/key"), "x", "unrelated entry untouched");
});

test("KV store supports a custom prefix", async () => {
  const kv = createMemoryKv();
  const store = createKeyValueDomainBindingStore({
    store: kv,
    prefix: "tenants/acme/domains",
  });
  await addDomainBinding(store, { host: "acme.com" });

  const raw = await kv.get("tenants/acme/domains/acme.com");
  assert.ok(raw, "binding stored under the configured prefix");
});

// ---------- listAuthorizedHostsForService ----------

test("listAuthorizedHostsForService returns [] for system scope", async () => {
  const result = await listAuthorizedHostsForService({
    scope: "system",
    serviceName: "@zelavis/ui",
    domainBindings: createInMemoryDomainBindingStore(),
  });
  assert.deepEqual(result, []);
});

test("listAuthorizedHostsForService returns [] when no store is configured for workspace", async () => {
  const result = await listAuthorizedHostsForService({
    scope: "extension",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });
  assert.deepEqual(result, []);
});

test("listAuthorizedHostsForService returns [] without workspace ownership context", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "workspace.example",
    projectId: "ws-1",
  });
  await verifyDomainBindingManually(store, "workspace.example");

  const result = await listAuthorizedHostsForService({
    scope: "extension",
    serviceName: "@example/kanban",
    domainBindings: store,
  });
  assert.deepEqual(result, []);
});

test("listAuthorizedHostsForService only allows verified bindings owned by the service's workspace", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "owned.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });
  await verifyDomainBindingManually(store, "owned.com");

  await addDomainBinding(store, {
    host: "other-tenant.com",
    projectId: "ws-2",
    serviceName: "@example/kanban",
  });
  await verifyDomainBindingManually(store, "other-tenant.com");

  await addDomainBinding(store, {
    host: "unverified.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });
  await addDomainBinding(store, {
    host: "other-service.com",
    projectId: "ws-1",
    serviceName: "@example/billing",
  });
  await verifyDomainBindingManually(store, "other-service.com");

  const allowed = await listAuthorizedHostsForService({
    scope: "extension",
    projectId: "ws-1",
    serviceName: "@example/kanban",
    domainBindings: store,
  });
  assert.deepEqual(allowed, ["owned.com"]);
});

test("listAuthorizedHostsForService rejects wildcard host for workspace services", async () => {
  const store = createInMemoryDomainBindingStore();
  await store.put(
    {
      host: "*",
      projectId: "ws-1",
      serviceName: "@example/kanban",
      verificationToken: "tok",
      verifiedAt: "2026-01-01T00:00:00Z",
      verificationMethod: "manual",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    "insert",
  );
  const allowed = await listAuthorizedHostsForService({
    scope: "extension",
    projectId: "ws-1",
    serviceName: "@example/kanban",
    domainBindings: store,
  });
  assert.deepEqual(allowed, []);
});

test("listAuthorizedHostsForService honors workspace-level bindings (no serviceName)", async () => {
  // A binding without a serviceName is workspace-wide — any service in
  // that workspace can use the host.
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "workspace.example",
    projectId: "ws-1",
    // serviceName intentionally omitted
  });
  await verifyDomainBindingManually(store, "workspace.example");

  const allowed = await listAuthorizedHostsForService({
    scope: "extension",
    projectId: "ws-1",
    serviceName: "@example/any-service",
    domainBindings: store,
  });
  assert.deepEqual(allowed, ["workspace.example"]);
});

// ---------- End-to-end: synthesizer integration ----------

test("synthesizeServiceAppService uses verified bindings for workspace-service app hosts", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "kanban.acme.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });
  await verifyDomainBindingManually(store, "kanban.acme.com");
  // unverified binding for evil.com — should NOT enable host routing
  await addDomainBinding(store, {
    host: "evil.com",
    projectId: "ws-1",
    serviceName: "@example/kanban",
  });

  const service = {
    name: "@example/kanban",
    scope: "extension",
    app: {
      mount: "/",
      bundle: "dist",
      domainPolicy: "optional",
    },
  };

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "ws-1/@example/kanban/dist/index.html",
        { body: utf8("kanban-shell"), contentType: "text/html" },
      ],
    ]),
  );

  const { services } = await activateServiceRegistry(
    [{ service, status: "installed" }],
    {
      rootPath: "/",
      api: { prefix: "/api", version: "v1", basePath: "/api/v1" },
      platform: {
        presets: [],
        resources: { keyValueStore: false, fileStorage: true },
        metadata: {},
      },
      core: {},
    },
    {
      bundleStore,
      projectId: "ws-1",
      domainBindings: store,
    },
  );

  const runtime = await createServiceRuntime({ services });

  // Verified host: serves the SPA shell
  const allowed = await runtime.fetch(
    new Request("http://kanban.acme.com/"),
  );
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /kanban-shell/);

  // Unverified host: does NOT route to this service (404 — no other
  // route matches)
  const rejected = await runtime.fetch(new Request("http://evil.com/"));
  assert.equal(rejected.status, 404);
});

test("system services bypass domain bindings entirely", async () => {
  // Even with no binding store configured, a system service still routes
  // host-agnostically — operator-deployed code is trusted.
  const service = {
    name: "@example/system-tool",
    scope: "system",
    app: {
      mount: "/",
      bundle: "dist",
    },
  };

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/@example/system-tool/dist/index.html",
        { body: utf8("system-tool-home"), contentType: "text/html" },
      ],
    ]),
  );

  const { services } = await activateServiceRegistry(
    [{ service, status: "installed" }],
    {
      rootPath: "/",
      api: { prefix: "/api", version: "v1", basePath: "/api/v1" },
      platform: {
        presets: [],
        resources: { keyValueStore: false, fileStorage: true },
        metadata: {},
      },
      core: {},
    },
    { bundleStore },
  );

  const runtime = await createServiceRuntime({ services });

  const response = await runtime.fetch(
    new Request("http://tool.example.com/"),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /system-tool-home/);
});

test("workspace apps with required domain policy do not synthesize without verified hosts", async () => {
  const service = {
    name: "@example/public-site",
    scope: "extension",
    app: {
      mount: "/",
      bundle: "dist",
      domainPolicy: "required",
    },
  };

  const { services } = await activateServiceRegistry(
    [{ service, status: "installed" }],
    {
      rootPath: "/",
      api: { prefix: "/api", version: "v1", basePath: "/api/v1" },
      platform: {
        presets: [],
        resources: { keyValueStore: false, fileStorage: true },
        metadata: {},
      },
      core: {},
    },
    {
      bundleStore: createInMemoryBundleStore(new Map()),
      projectId: "ws-1",
      domainBindings: createInMemoryDomainBindingStore(),
    },
  );

  const appService = (await Promise.all(services)).find(
    (service) => service.name === "@example/public-site:app",
  );
  assert.equal(appService, undefined);
});
