import assert from "node:assert/strict";
import test from "node:test";

test("zelavis package exports runtime APIs and adapter subpaths", async () => {
  const runtime = await import("zelavis");
  const elysiaAdapter = await import("zelavis/adapters/elysia");
  const nodeAdapter = await import("zelavis/adapters/node");
  const expressAdapter = await import("zelavis/adapters/express");
  const fastifyAdapter = await import("zelavis/adapters/fastify");
  const honoAdapter = await import("zelavis/adapters/hono");
  const h3Adapter = await import("zelavis/adapters/h3");
  const nextjsPagesRouterAdapter =
    await import("zelavis/adapters/nextjs-pages-router");
  const nodePlatform = await import("zelavis/platforms/node");
  const bunPlatform = await import("zelavis/platforms/bun");
  const cloudflarePlatform = await import("zelavis/platforms/cloudflare");
  const netlifyPlatform = await import("zelavis/platforms/netlify");
  const vercelPlatform = await import("zelavis/platforms/vercel");
  const s3Storage = await import("zelavis/storage/s3");

  assert.equal(typeof runtime.zelavis, "function");
  assert.equal(typeof runtime.Zelavis, "function");
  assert.equal(typeof runtime.createAdapter, "function");
  assert.equal(typeof runtime.definePlugin, "function");
  assert.equal(typeof runtime.createPluginRegistry, "function");
  assert.equal(runtime.ZELAVIS_PLUGIN_V1, "ZELAVIS_PLUGIN_V1");
  assert.equal(typeof runtime.loadPlugin, "function");
  assert.equal(typeof runtime.loadPluginRegistry, "function");
  assert.equal(typeof runtime.resolvePluginModule, "function");
  assert.equal(typeof runtime.removePluginFromRegistry, "function");
  assert.equal(typeof runtime.createPlatform, "function");
  assert.equal(typeof runtime.createDatabase, "function");
  assert.equal(typeof runtime.createFileReference, "function");
  assert.equal(typeof runtime.createS3CompatibleFileStorage, "function");
  assert.equal(typeof runtime.resolveS3CacheControlPreset, "function");
  assert.equal(typeof runtime.defineService, "function");
  assert.equal("zelavisServer" in runtime, false);
  assert.equal(typeof elysiaAdapter.elysiaAdapter, "function");
  assert.equal(typeof nodeAdapter.nodeAdapter, "function");
  assert.equal(
    typeof nodeAdapter.createFileDashboardSettingsStore,
    "function",
  );
  assert.equal(typeof expressAdapter.expressAdapter, "function");
  assert.equal(typeof fastifyAdapter.fastifyAdapter, "function");
  assert.equal(typeof honoAdapter.honoAdapter, "function");
  assert.equal(typeof h3Adapter.h3Adapter, "function");
  assert.equal(
    typeof nextjsPagesRouterAdapter.nextjsPagesRouterAdapter,
    "function",
  );
  assert.equal(typeof nodePlatform.nodePlatform, "function");
  assert.equal(typeof bunPlatform.bunPlatform, "function");
  assert.equal(typeof cloudflarePlatform.cloudflarePlatform, "function");
  assert.equal(typeof netlifyPlatform.netlifyPlatform, "function");
  assert.equal(typeof vercelPlatform.vercelPlatform, "function");
  assert.equal(typeof s3Storage.createS3CompatibleFileStorage, "function");
  assert.equal(typeof s3Storage.resolveS3CacheControlPreset, "function");
});

test("Zelavis class can bind a node adapter and accept a node platform preset", async () => {
  const { Zelavis } = await import("zelavis");
  const { nodeAdapter } = await import("zelavis/adapters/node");
  const { nodePlatform } = await import("zelavis/platforms/node");

  const zelavis = new Zelavis({
    adapter: nodeAdapter(),
    platform: nodePlatform(),
  });

  assert.equal(typeof zelavis.adapter.nodeServer, "function");
});

test("cloudflare platform requires the standard D1 binding when env is provided", async () => {
  const { cloudflarePlatform } = await import("zelavis/platforms/cloudflare");

  await assert.rejects(
    () => cloudflarePlatform({ env: {} }).resolve({}),
    /Missing or invalid Cloudflare D1 binding `ZELAVIS_DB`/,
  );
});

test("cloudflare platform infers KV and file resources from standard env bindings", async () => {
  const { cloudflarePlatform } = await import("zelavis/platforms/cloudflare");
  const database = {
    prepare() {
      return {
        bind() {
          return this;
        },
        all: async () => ({ results: [], success: true }),
        run: async () => ({ success: true }),
      };
    },
    async batch() {
      return [];
    },
  };

  const kv = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list() {
      return { keys: [], list_complete: true };
    },
  };
  const bucket = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };

  const resolved = await cloudflarePlatform({
    env: {
      ZELAVIS_DB: database,
      ZELAVIS_KV: kv,
      ZELAVIS_FILES: bucket,
    },
  }).resolve({});

  assert.equal(typeof resolved.resources.kv.get, "function");
  assert.equal(typeof resolved.resources.files.put, "function");
});

test("Zelavis rejects internal runtime options on the public class constructor", async () => {
  const { Zelavis } = await import("zelavis");

  assert.throws(
    () =>
      new Zelavis({
        coreServices: {
          dashboard: false,
        },
      }),
    /does not accept internal runtime options/,
  );

  assert.throws(
    () =>
      new Zelavis({
        services: [],
      }),
    /does not accept internal runtime options/,
  );
});

test("Zelavis merges platform resources and metadata for adapters", async () => {
  const { Zelavis, createAdapter, createPlatform } = await import("zelavis");

  let capturedPlatform;

  const firstPlatform = createPlatform({
    name: "first",
    resolve() {
      return {
        metadata: { runtime: "custom", first: true },
        resources: {
          kv: {
            get() {
              return "alpha";
            },
            set() {},
            delete() {
              return true;
            },
          },
        },
      };
    },
  });

  const secondPlatform = createPlatform({
    name: "second",
    resolve() {
      return {
        metadata: { second: true },
        resources: {
          files: {
            get() {
              return undefined;
            },
            put(input) {
              return { path: input.path };
            },
            delete() {
              return false;
            },
          },
        },
      };
    },
  });

  const zelavis = new Zelavis({
    adapter: createAdapter({
      name: "capture",
      bind(context) {
        return {
          async snapshot() {
            await context.getRuntime();
            capturedPlatform = context.getPlatform();
            return capturedPlatform;
          },
        };
      },
    }),
    platform: [firstPlatform, secondPlatform],
  });

  const snapshot = await zelavis.adapter.snapshot();

  assert.deepEqual(snapshot.presets, ["first", "second"]);
  assert.equal(snapshot.metadata.runtime, "custom");
  assert.equal(snapshot.metadata.first, true);
  assert.equal(snapshot.metadata.second, true);
  assert.equal(snapshot.resources.kv.get("x"), "alpha");
  assert.equal(typeof snapshot.resources.files.put, "function");
  assert.equal(capturedPlatform, snapshot);
});

test("Zelavis platform resources back dashboard settings, website pages, and storage service", async () => {
  const { Zelavis, createPlatform } = await import("zelavis");

  const kv = new Map();
  const files = new Map();

  const platform = createPlatform({
    name: "storage-only",
    resolve() {
      return {
        coreServices: {
          database: false,
        },
        resources: {
          kv: {
            get(key) {
              return kv.get(key);
            },
            set(key, value) {
              kv.set(key, value);
            },
            delete(key) {
              return kv.delete(key);
            },
          },
          files: {
            get(path) {
              return files.get(path);
            },
            put(input) {
              const body =
                typeof input.body === "string"
                  ? new TextEncoder().encode(input.body)
                  : input.body instanceof Uint8Array
                    ? input.body
                    : input.body instanceof ArrayBuffer
                      ? new Uint8Array(input.body)
                      : new Uint8Array();
              const entry = {
                path: input.path,
                body,
                size: body.byteLength,
                updatedAt: new Date(),
                contentType: input.contentType,
                metadata: input.metadata,
              };
              files.set(input.path, entry);
              return entry;
            },
            delete(path) {
              return files.delete(path);
            },
            list(prefix) {
              return [...files.values()]
                .filter((entry) => (prefix ? entry.path.startsWith(prefix) : true))
                .map((entry) => ({
                  path: entry.path,
                  size: entry.size,
                  updatedAt: entry.updatedAt,
                  contentType: entry.contentType,
                  metadata: entry.metadata,
                }));
            },
          },
        },
      };
    },
  });

  const zelavis = new Zelavis({
    platform,
    plugins: {
      store: {
        read() {
          return [
            {
              name: "zelavis-ecommerce",
              status: "installed",
              order: 0,
            },
          ];
        },
        write(entries) {
          return entries;
        },
      },
    },
  });

  const commerceHealthResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/health"),
  );
  const commerceHealth = await commerceHealthResponse.json();

  assert.equal(commerceHealthResponse.status, 200);
  assert.equal(commerceHealth.plugin, "zelavis-ecommerce");
  assert.deepEqual(commerceHealth.platform.presets, ["storage-only"]);
  assert.deepEqual(commerceHealth.platform.resources, {
    keyValueStore: true,
    fileStorage: true,
  });

  const updateResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/dashboard/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        theme: "dark",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);
  assert.equal(kv.has("zelavis/dashboard-settings.json"), true);

  const createPageResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/",
        title: "Home",
      }),
    }),
  );

  assert.equal(createPageResponse.status, 201);
  assert.equal(files.has("zelavis/website-pages.json"), true);

  const uploadResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt", {
      method: "PUT",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-zelavis-meta-origin": "test",
      },
      body: "hello world",
    }),
  );

  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.file.path, "uploads/hello.txt");
  assert.equal(typeof uploaded.file.checksum, "string");
  assert.equal(uploaded.file.metadata.origin, "test");
  assert.equal(uploaded.reference.href, "/zelavis/api/v1/storage/files/uploads/hello.txt");
  assert.equal(files.has("uploads/hello.txt"), true);

  const listResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files?prefix=uploads/"),
  );
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(Array.isArray(listed.files), true);
  assert.equal(listed.files.some((file) => file.path === "uploads/hello.txt"), true);
  assert.equal(Array.isArray(listed.references), true);

  const metadataResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt?format=metadata"),
  );
  assert.equal(metadataResponse.status, 200);
  const metadataBody = await metadataResponse.json();
  assert.equal(metadataBody.file.path, "uploads/hello.txt");
  assert.equal(metadataBody.file.metadata.origin, "test");
  assert.equal(typeof metadataBody.file.checksum, "string");
  assert.equal(
    metadataBody.reference.metadataHref,
    "/zelavis/api/v1/storage/files/uploads/hello.txt?format=metadata",
  );

  const readResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt"),
  );
  assert.equal(readResponse.status, 200);
  assert.equal(typeof readResponse.headers.get("x-zelavis-checksum-sha256"), "string");
  assert.equal(await readResponse.text(), "hello world");

  const deleteResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt", {
      method: "DELETE",
    }),
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(files.has("uploads/hello.txt"), false);
});

test("Zelavis rejects installed plugins that try to register reserved core service names", async () => {
  const { Zelavis, definePlugin, createPluginRegistry, defineService } =
    await import("zelavis");

  const forbiddenPlugin = definePlugin({
    name: "evil-auth-plugin",
    services: [
      defineService({
        name: "auth",
        service: {},
        api: {
          v1: [],
        },
      }),
    ],
  });

  const zelavis = new Zelavis({
    plugins: {
      entries: createPluginRegistry([
        {
          plugin: forbiddenPlugin,
          status: "installed",
        },
      ]),
    },
  });

  await assert.rejects(
    () => zelavis.runtime(),
    /Plugins cannot register reserved core service names: auth/,
  );
});
