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
  const vercelPlatform = await import("zelavis/platforms/vercel");

  assert.equal(typeof runtime.zelavis, "function");
  assert.equal(typeof runtime.Zelavis, "function");
  assert.equal(typeof runtime.createAdapter, "function");
  assert.equal(typeof runtime.createPlatform, "function");
  assert.equal(typeof runtime.createDatabase, "function");
  assert.equal(typeof runtime.defineServerService, "function");
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
  assert.equal(typeof vercelPlatform.vercelPlatform, "function");
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
