import assert from "node:assert/strict";
import test from "node:test";

import {
  ZELAVIS_PROVIDER_V1,
  ZELAVIS_RUNTIME_ARTIFACT_V1,
  defineCompatibilityDate,
  defineProvider,
  defineRuntimeArtifact,
  defineServerPlugin,
  getProviderCapability,
  createServiceRuntime,
} from "../dist/core/index.js";

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

test("provider definitions negotiate narrow capabilities", async () => {
  const capacity = {
    provision: async () => ({ nodeId: "node-a" }),
  };
  const provider = defineProvider({
    contractVersion: ZELAVIS_PROVIDER_V1,
    name: "example-cloud",
    compatibilityDate: "2026-08-27",
    capabilities: [
      { kind: "capacity", api: capacity },
      { kind: "dns", api: { zones: true } },
    ],
  });

  assert.equal(getProviderCapability(provider, "capacity"), capacity);
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
