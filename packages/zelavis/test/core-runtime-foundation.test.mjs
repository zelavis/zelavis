import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ZELAVIS_PROVIDER_V1,
  ZELAVIS_RUNTIME_ARTIFACT_V1,
  ZELAVIS_RUNTIME_BUILD_PROFILE_V1,
  artifactStoreCapability,
  capacityProviderCapability,
  createArtifactDigest,
  createMemoryArtifactStore,
  defineCompatibilityDate,
  defineProvider,
  defineRuntimeBuildProfile,
  defineRuntimeArtifact,
  defineServerPlugin,
  getProviderCapability,
  createServiceRuntime,
} from "../dist/core/index.js";
import { createNodeFileArtifactStore } from "../dist/adapters/node.js";

test("compatibility dates are validated and exposed by the runtime", async () => {
  assert.equal(defineCompatibilityDate("2026-08-27"), "2026-08-27");
  assert.throws(() => defineCompatibilityDate("2026-02-30"), /valid date/);
  assert.throws(() => defineCompatibilityDate("27-08-2026"), /YYYY-MM-DD/);

  const runtime = await createServiceRuntime({
    compatibilityDate: "2026-08-27",
    services: [],
  });

  assert.equal(runtime.compatibilityDate, "2026-08-27");
});

test("server plugins receive ordered lifecycle events and clean up once", async () => {
  const events = [];
  const plugin = defineServerPlugin(({ hooks, compatibilityDate }) => {
    events.push(`setup:${compatibilityDate}`);
    hooks.hook("start", ({ routes }) => events.push(`start:${routes.length}`));
    hooks.hook("request", ({ request }) => {
      events.push(`request:${new URL(request.url).pathname}`);
    });
    hooks.hook("response", ({ result }) => {
      events.push(`response:${result.response.status}`);
    });
    hooks.hook("close", () => events.push("close"));
    return () => events.push("cleanup");
  });
  const runtime = await createServiceRuntime({
    compatibilityDate: "2026-08-27",
    plugins: [plugin],
    services: [
      {
        name: "health",
        service: {},
        api: {
          v1: [
            {
              id: "health.read",
              method: "GET",
              path: "/",
              handler: () => ({ body: { ok: true } }),
            },
          ],
        },
      },
    ],
  });

  const response = await runtime.fetch(
    new Request("http://localhost/health"),
  );
  await Promise.all([runtime.close(), runtime.close()]);

  assert.equal(response.status, 200);
  assert.deepEqual(events, [
    "setup:2026-08-27",
    "start:1",
    "request:/health",
    "response:200",
    "close",
    "cleanup",
  ]);
});

test("server startup and close run every registered plugin cleanup", async () => {
  const startupEvents = [];
  await assert.rejects(
    createServiceRuntime({
      services: [],
      plugins: [
        () => () => startupEvents.push("first-cleanup"),
        () => {
          throw new Error("setup failed");
        },
      ],
    }),
    /setup failed/,
  );
  assert.deepEqual(startupEvents, ["first-cleanup"]);

  const closeEvents = [];
  const runtime = await createServiceRuntime({
    services: [],
    plugins: [
      ({ hooks }) => {
        hooks.hook("close", () => {
          closeEvents.push("close");
          throw new Error("close failed");
        });
        return () => closeEvents.push("first-cleanup");
      },
      () => () => closeEvents.push("second-cleanup"),
    ],
  });

  await assert.rejects(runtime.close(), /close failed/);
  assert.deepEqual(closeEvents, [
    "close",
    "second-cleanup",
    "first-cleanup",
  ]);
});

test("error lifecycle hooks receive the failed route request", async () => {
  let observed;
  const runtime = await createServiceRuntime({
    plugins: [
      defineServerPlugin(({ hooks }) => {
        hooks.hook("error", (event) => {
          observed = event;
        });
      }),
    ],
    services: [
      {
        name: "broken",
        service: {},
        api: {
          v1: [
            {
              id: "broken.read",
              method: "GET",
              path: "/",
              handler: () => {
                throw new Error("broken route");
              },
            },
          ],
        },
      },
    ],
  });

  const response = await runtime.fetch(
    new Request("http://localhost/broken"),
  );

  assert.equal(response.status, 500);
  assert.equal(observed.error.message, "broken route");
  assert.equal(observed.request.url, "http://localhost/broken");
  assert.equal(observed.resolvedRoute.route.id, "broken.read");
});

test("portable runtime artifact manifests validate deterministic bundle paths", () => {
  const manifest = defineRuntimeArtifact({
    formatVersion: ZELAVIS_RUNTIME_ARTIFACT_V1,
    name: "example-app",
    runtime: "bun",
    entrypoint: "server/index.js",
    files: ["server/index.js", "public/index.html"],
    compatibilityDate: "2026-08-27",
  });

  assert.equal(manifest.runtime, "bun");
  assert.deepEqual(manifest.files, ["public/index.html", "server/index.js"]);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.files), true);
  assert.throws(
    () =>
      defineRuntimeArtifact({
        formatVersion: ZELAVIS_RUNTIME_ARTIFACT_V1,
        name: "unsafe",
        runtime: "node",
        entrypoint: "../index.js",
        files: ["../index.js"],
      }),
    /bundle-relative/,
  );
});

test("Node ArtifactStore persists immutable digest-verified objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-artifacts-"));
  try {
    const body = new TextEncoder().encode("immutable runtime artifact");
    const digest = await createArtifactDigest(body);
    const first = createNodeFileArtifactStore({ directory });
    await first.put({
      digest,
      body,
      contentType: "application/octet-stream",
      metadata: { runtime: "node" },
    });

    const reopened = createNodeFileArtifactStore({ directory });
    assert.equal(await reopened.has(digest), true);
    assert.deepEqual(await reopened.get(digest), {
      digest,
      body,
      contentType: "application/octet-stream",
      metadata: { runtime: "node" },
    });

    await reopened.put({ digest, body, metadata: { runtime: "changed" } });
    assert.deepEqual((await reopened.get(digest)).metadata, { runtime: "node" });
    await assert.rejects(
      reopened.put({ digest, body: new TextEncoder().encode("different") }),
      /digest mismatch/,
    );

    const hex = digest.slice("sha256:".length);
    const storedPath = join(directory, "sha256", hex.slice(0, 2), `${hex}.artifact`);
    assert.equal((await readFile(storedPath, "utf8")), "immutable runtime artifact");
    await writeFile(storedPath, "corrupt");
    await assert.rejects(reopened.get(digest), /is corrupt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime build profiles select engines without provider assumptions", () => {
  const profile = defineRuntimeBuildProfile({
    formatVersion: ZELAVIS_RUNTIME_BUILD_PROFILE_V1,
    runtime: "node",
    entrypoint: "server/index.js",
    compatibilityDate: "2026-08-27",
    conditions: ["production", "node", "production"],
  });

  assert.deepEqual(profile.conditions, ["node", "production"]);
  assert.equal(Object.isFrozen(profile), true);
  assert.throws(
    () => defineRuntimeBuildProfile({
      formatVersion: ZELAVIS_RUNTIME_BUILD_PROFILE_V1,
      runtime: "node",
      entrypoint: "/absolute.js",
    }),
    /bundle-relative/,
  );
});

test("ArtifactStore verifies immutable content-addressed objects", async () => {
  const store = createMemoryArtifactStore();
  const body = new TextEncoder().encode("immutable runtime");
  const digest = await createArtifactDigest(body);
  const capability = artifactStoreCapability(store);

  await store.put({ digest, body, contentType: "application/octet-stream" });
  body[0] = 0;
  const stored = await store.get(digest);

  assert.equal(capability.kind, "artifacts");
  assert.equal(await store.has(digest), true);
  assert.equal(new TextDecoder().decode(stored.body), "immutable runtime");
  stored.body[0] = 0;
  assert.equal(
    new TextDecoder().decode((await store.get(digest)).body),
    "immutable runtime",
  );
  await assert.rejects(
    store.put({ digest, body: new TextEncoder().encode("different") }),
    /digest mismatch/,
  );
});

test("runtime artifact manifests validate digests and signature metadata", async () => {
  const entryDigest = await createArtifactDigest("entry");
  const manifestDigest = await createArtifactDigest("bundle");
  const manifest = defineRuntimeArtifact({
    formatVersion: ZELAVIS_RUNTIME_ARTIFACT_V1,
    name: "signed-app",
    runtime: "bun",
    entrypoint: "index.js",
    files: ["index.js"],
    digest: manifestDigest,
    fileDigests: { "index.js": entryDigest },
    signature: { algorithm: "ed25519", keyId: "release-1", value: "signature" },
  });

  assert.equal(manifest.digest, manifestDigest);
  assert.equal(Object.isFrozen(manifest.fileDigests), true);
  assert.throws(
    () => defineRuntimeArtifact({
      formatVersion: ZELAVIS_RUNTIME_ARTIFACT_V1,
      name: "incomplete",
      runtime: "node",
      entrypoint: "index.js",
      files: ["index.js", "other.js"],
      fileDigests: { "index.js": entryDigest },
    }),
    /exactly every declared file/,
  );
});

test("provider definitions negotiate narrow capabilities", async () => {
  const capacityApi = {
    list: async () => [],
    get: async () => undefined,
    provision: async (input) => ({
      id: `node-${input.requestId}`,
      provider: "example-cloud",
      state: "provisioning",
    }),
    release: async () => undefined,
  };
  const capacity = capacityProviderCapability(capacityApi);
  const provider = defineProvider({
    contractVersion: ZELAVIS_PROVIDER_V1,
    name: "example-cloud",
    compatibilityDate: "2026-08-27",
    capabilities: [
      capacity,
      { kind: "dns", api: { zones: true } },
    ],
  });

  assert.equal(getProviderCapability(provider, "capacity"), capacityApi);
  assert.equal(getProviderCapability(provider, "backups"), undefined);
  assert.throws(
    () =>
      defineProvider({
        contractVersion: ZELAVIS_PROVIDER_V1,
        name: "duplicate",
        capabilities: [
          { kind: "dns", api: {} },
          { kind: "dns", api: {} },
        ],
      }),
    /more than once/,
  );
});

test("capacity providers provision Nodes without accepting Project placement", async () => {
  const provisioned = [];
  const capability = capacityProviderCapability({
    async list() { return provisioned; },
    async get(nodeId) { return provisioned.find((node) => node.id === nodeId); },
    async provision(input) {
      const node = {
        id: `node-${input.requestId}`,
        provider: "local-lab",
        state: "ready",
        resources: input.resources,
      };
      provisioned.push(node);
      return node;
    },
    async release(nodeId) {
      const index = provisioned.findIndex((node) => node.id === nodeId);
      if (index >= 0) provisioned.splice(index, 1);
    },
  });

  const node = await capability.api.provision({
    requestId: "request-1",
    platformId: "platform-a",
    resources: { cpuCores: 4 },
  });
  assert.equal(node.id, "node-request-1");
  assert.equal("projectId" in node, false);
  assert.equal((await capability.api.list()).length, 1);
});

test("new framework contracts are available through narrow package subpaths", async () => {
  const [artifact, compatibility, lifecycle, provider] = await Promise.all([
    import("zelavis/artifact"),
    import("zelavis/runtime"),
    import("zelavis/runtime"),
    import("zelavis/provider"),
  ]);

  assert.equal(typeof artifact.defineRuntimeArtifact, "function");
  assert.equal(typeof compatibility.defineCompatibilityDate, "function");
  assert.equal(typeof lifecycle.defineServerPlugin, "function");
  assert.equal(typeof provider.defineProvider, "function");
});
