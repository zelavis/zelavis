import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePluginRegistry,
  addDomainBinding,
  createInMemoryBundleStore,
  createInMemoryDomainBindingStore,
  createKeyValueDomainBindingStore,
  definePlugin,
  filterAuthorizedHostsForPlugin,
  generateVerificationToken,
  revokeDomainBindingVerification,
  verifyDomainBindingManually,
} from "../dist/index.js";
import { zelavisServer } from "@zelavis/server";

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
    workspaceId: "ws-1",
    pluginName: "kanban",
  });

  assert.equal(binding.host, "acme.com");
  assert.equal(binding.workspaceId, "ws-1");
  assert.equal(binding.pluginName, "kanban");
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

test("in-memory store list filters by workspace, plugin, and verified status", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "a.example.com",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });
  await addDomainBinding(store, {
    host: "b.example.com",
    workspaceId: "ws-1",
    pluginName: "billing",
  });
  await addDomainBinding(store, {
    host: "c.example.com",
    workspaceId: "ws-2",
    pluginName: "kanban",
  });
  await verifyDomainBindingManually(store, "a.example.com");

  // All
  assert.equal((await store.list()).length, 3);
  // By workspace
  const ws1 = await store.list({ workspaceId: "ws-1" });
  assert.deepEqual(
    ws1.map((b) => b.host),
    ["a.example.com", "b.example.com"],
  );
  // By plugin
  const kanban = await store.list({ pluginName: "kanban" });
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
    workspaceId: "ws-1",
  });
  await verifyDomainBindingManually(store, "acme.com");

  const fetched = await store.get("acme.com");
  assert.ok(fetched);
  assert.equal(fetched.workspaceId, "ws-1");
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

// ---------- filterAuthorizedHostsForPlugin ----------

test("filterAuthorizedHostsForPlugin passes through declared hosts for system scope", async () => {
  const result = await filterAuthorizedHostsForPlugin(
    ["a.com", "b.com"],
    {
      scope: "system",
      pluginName: "dashboard",
      domainBindings: createInMemoryDomainBindingStore(),
    },
  );
  assert.deepEqual(result, ["a.com", "b.com"]);
});

test("filterAuthorizedHostsForPlugin returns [] when no store is configured for workspace", async () => {
  const result = await filterAuthorizedHostsForPlugin(["a.com"], {
    scope: "workspace",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });
  assert.deepEqual(result, []);
});

test("filterAuthorizedHostsForPlugin only allows verified bindings owned by the plugin's workspace", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "owned.com",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });
  await verifyDomainBindingManually(store, "owned.com");

  await addDomainBinding(store, {
    host: "other-tenant.com",
    workspaceId: "ws-2",
    pluginName: "kanban",
  });
  await verifyDomainBindingManually(store, "other-tenant.com");

  await addDomainBinding(store, {
    host: "unverified.com",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });

  const allowed = await filterAuthorizedHostsForPlugin(
    ["owned.com", "other-tenant.com", "unverified.com", "unknown.com"],
    {
      scope: "workspace",
      workspaceId: "ws-1",
      pluginName: "kanban",
      domainBindings: store,
    },
  );
  assert.deepEqual(allowed, ["owned.com"]);
});

test("filterAuthorizedHostsForPlugin rejects wildcard host for workspace plugins", async () => {
  const store = createInMemoryDomainBindingStore();
  // Even if somehow a workspace binding existed for `*`, it shouldn't be
  // honored — workspace plugins claiming wildcard would swallow every
  // unmatched request.
  const allowed = await filterAuthorizedHostsForPlugin(["*"], {
    scope: "workspace",
    workspaceId: "ws-1",
    pluginName: "kanban",
    domainBindings: store,
  });
  assert.deepEqual(allowed, []);
});

test("filterAuthorizedHostsForPlugin honors workspace-level bindings (no pluginName)", async () => {
  // A binding without a pluginName is workspace-wide — any plugin in
  // that workspace can claim the host.
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "workspace.example",
    workspaceId: "ws-1",
    // pluginName intentionally omitted
  });
  await verifyDomainBindingManually(store, "workspace.example");

  const allowed = await filterAuthorizedHostsForPlugin(["workspace.example"], {
    scope: "workspace",
    workspaceId: "ws-1",
    pluginName: "any-plugin",
    domainBindings: store,
  });
  assert.deepEqual(allowed, ["workspace.example"]);
});

// ---------- End-to-end: synthesizer integration ----------

test("synthesizePluginAppService filters workspace-plugin domains to verified bindings", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, {
    host: "kanban.acme.com",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });
  await verifyDomainBindingManually(store, "kanban.acme.com");
  // unverified binding for evil.com — should NOT enable host routing
  await addDomainBinding(store, {
    host: "evil.com",
    workspaceId: "ws-1",
    pluginName: "kanban",
  });

  const plugin = definePlugin({
    name: "kanban",
    scope: "workspace",
    app: {
      mount: "/",
      bundle: "dist",
      // Plugin declares both hosts, but the synthesizer should only
      // honor the verified one.
      domains: ["kanban.acme.com", "evil.com"],
    },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "ws-1/kanban/dist/index.html",
        { body: utf8("kanban-shell"), contentType: "text/html" },
      ],
    ]),
  );

  const { services } = await activatePluginRegistry(
    [{ plugin, status: "installed" }],
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
      workspaceId: "ws-1",
      domainBindings: store,
    },
  );

  const runtime = await zelavisServer({ services });

  // Verified host: serves the SPA shell
  const allowed = await runtime.fetch(
    new Request("http://kanban.acme.com/"),
  );
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /kanban-shell/);

  // Unverified host: does NOT route to this plugin (404 — no other
  // route matches)
  const rejected = await runtime.fetch(new Request("http://evil.com/"));
  assert.equal(rejected.status, 404);
});

test("system plugins bypass domain bindings entirely", async () => {
  // Even with no binding store configured, a system plugin's declared
  // hosts still route — operator-deployed code is trusted.
  const plugin = definePlugin({
    name: "system-tool",
    scope: "system",
    app: {
      mount: "/",
      bundle: "dist",
      domains: ["tool.example.com"],
    },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/system-tool/dist/index.html",
        { body: utf8("system-tool-home"), contentType: "text/html" },
      ],
    ]),
  );

  const { services } = await activatePluginRegistry(
    [{ plugin, status: "installed" }],
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

  const runtime = await zelavisServer({ services });

  const response = await runtime.fetch(
    new Request("http://tool.example.com/"),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /system-tool-home/);
});
