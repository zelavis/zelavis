import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePluginRegistry,
  createInMemoryBundleStore,
  createSharedBundleStore,
  buildBundleStorageKey,
  definePlugin,
} from "../dist/index.js";
import { zelavisServer } from "@zelavis/server";

const utf8 = (text) => new TextEncoder().encode(text);

// ---------- definePlugin / app validation ----------

test("definePlugin accepts an app field and freezes it", () => {
  const plugin = definePlugin({
    name: "kanban",
    app: {
      mount: "/kanban",
      bundle: "dist",
      mode: "spa",
      domains: ["kanban.example.com", { host: "kanban.acme.com" }],
    },
  });

  assert.equal(plugin.app?.mount, "/kanban");
  assert.equal(plugin.app?.bundle, "dist");
  assert.equal(plugin.app?.mode, "spa");
  assert.deepEqual(
    plugin.app?.domains,
    ["kanban.example.com", { host: "kanban.acme.com" }],
  );
  assert.equal(Object.isFrozen(plugin.app), true);
  assert.equal(Object.isFrozen(plugin.app.domains), true);
});

test("definePlugin rejects an invalid app mode", () => {
  assert.throws(
    () =>
      definePlugin({
        name: "bad-mode",
        app: { mount: "/", mode: "ssr" },
      }),
    /Plugin app mode must be "spa" or "mpa"/,
  );
});

test("definePlugin rejects an app mount without a leading slash", () => {
  assert.throws(
    () =>
      definePlugin({
        name: "no-leading-slash",
        app: { mount: "no-slash" },
      }),
    /Plugin app mount must start with a leading slash/,
  );
});

test("definePlugin rejects a non-string app domain entry", () => {
  assert.throws(
    () =>
      definePlugin({
        name: "bad-domains",
        app: { domains: [42] },
      }),
    /domain entries must be strings or binding objects/,
  );
});

// ---------- BundleStore ----------

test("buildBundleStorageKey encodes scope identity into a deterministic path", () => {
  const key = buildBundleStorageKey(
    { workspaceId: "ws_1", pluginName: "kanban", bundle: "dist" },
    "assets/index.js",
  );
  assert.equal(key, "apps/ws_1/kanban/dist/assets/index.js");

  const systemKey = buildBundleStorageKey(
    { pluginName: "dashboard", bundle: "dist" },
    "index.html",
  );
  assert.equal(systemKey, "apps/system/dashboard/dist/index.html");
});

test("createSharedBundleStore reads through the underlying ZelavisFileStorage", async () => {
  const stored = new Map();
  const fakeStorage = {
    async get(path) {
      const value = stored.get(path);
      return value
        ? { path, body: value, contentType: "text/html; charset=utf-8" }
        : undefined;
    },
    async put() {
      throw new Error("not used");
    },
    async delete() {
      return true;
    },
  };

  stored.set(
    "apps/system/kanban/dist/index.html",
    utf8("<!doctype html><body>kanban</body>"),
  );

  const store = createSharedBundleStore({ storage: fakeStorage });
  const asset = await store.read(
    { pluginName: "kanban", bundle: "dist" },
    "index.html",
  );

  assert.ok(asset);
  assert.equal(asset.contentType, "text/html; charset=utf-8");
  assert.match(new TextDecoder().decode(asset.body), /kanban/);
});

// ---------- Activation synthesizes asset-serving routes ----------

test("activatePluginRegistry synthesizes an app service for system plugins", async () => {
  const plugin = definePlugin({
    name: "kanban",
    scope: "system",
    app: { mount: "/kanban", bundle: "dist" },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      ["system/kanban/dist/index.html", utf8("<!doctype html>kanban shell")],
      [
        "system/kanban/dist/assets/main.js",
        {
          body: utf8("console.log('hi')"),
          contentType: "text/javascript; charset=utf-8",
        },
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

  const resolvedServices = await Promise.all(services);
  const appService = resolvedServices.find((s) => s.name === "kanban:app");

  assert.ok(appService, "synthesized app service should be present");
  assert.equal(appService.basePath, "/kanban");
  assert.equal(appService.api.v1.length, 2);
  assert.deepEqual(
    appService.api.v1.map((r) => r.path).sort(),
    ["/", "/*path"],
  );
});

test("workspace-scoped plugins are remounted under /apps/<name> regardless of declared mount", async () => {
  const plugin = definePlugin({
    name: "tenant-app",
    scope: "workspace",
    app: { mount: "/zelavis", bundle: "dist" },
  });

  const bundleStore = createInMemoryBundleStore(new Map());

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

  const appService = (await Promise.all(services)).find(
    (s) => s.name === "tenant-app:app",
  );

  assert.ok(appService);
  assert.equal(
    appService.basePath,
    "/apps/tenant-app",
    "workspace mount should be rewritten",
  );
});

// ---------- End-to-end through zelavisServer + dispatcher ----------

test("a synthesized SPA service serves the index for unmatched sub-paths", async () => {
  const plugin = definePlugin({
    name: "kanban",
    scope: "system",
    app: { mount: "/kanban", bundle: "dist", mode: "spa" },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/kanban/dist/index.html",
        {
          body: utf8("<!doctype html>kanban-spa"),
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "system/kanban/dist/assets/main.js",
        {
          body: utf8("console.log('main')"),
          contentType: "text/javascript; charset=utf-8",
        },
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

  const indexResponse = await runtime.fetch(
    new Request("http://localhost/kanban"),
  );
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /kanban-spa/);

  const assetResponse = await runtime.fetch(
    new Request("http://localhost/kanban/assets/main.js"),
  );
  assert.equal(assetResponse.status, 200);
  assert.equal(
    assetResponse.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.match(await assetResponse.text(), /console\.log\('main'\)/);

  // SPA fallback: unknown sub-path returns the index shell.
  const deepLinkResponse = await runtime.fetch(
    new Request("http://localhost/kanban/board/123"),
  );
  assert.equal(deepLinkResponse.status, 200);
  assert.match(await deepLinkResponse.text(), /kanban-spa/);
});

test("MPA mode resolves directory-style requests to .html and index.html, no SPA fallback", async () => {
  const plugin = definePlugin({
    name: "marketing",
    scope: "system",
    app: { mount: "/marketing", bundle: "dist", mode: "mpa" },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/marketing/dist/index.html",
        {
          body: utf8("home"),
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "system/marketing/dist/about.html",
        {
          body: utf8("about-page"),
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "system/marketing/dist/docs/index.html",
        {
          body: utf8("docs-index"),
          contentType: "text/html; charset=utf-8",
        },
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

  const aboutResponse = await runtime.fetch(
    new Request("http://localhost/marketing/about"),
  );
  assert.equal(aboutResponse.status, 200);
  assert.match(await aboutResponse.text(), /about-page/);

  const docsResponse = await runtime.fetch(
    new Request("http://localhost/marketing/docs"),
  );
  assert.equal(docsResponse.status, 200);
  assert.match(await docsResponse.text(), /docs-index/);

  // No SPA fallback in MPA mode — unknown path is a real 404.
  const missingResponse = await runtime.fetch(
    new Request("http://localhost/marketing/nope"),
  );
  assert.equal(missingResponse.status, 404);
});

// ---------- app.devUrl ----------

test("app.devUrl short-circuits asset serving with a 307 redirect", async () => {
  const plugin = definePlugin({
    name: "vite-app",
    scope: "system",
    app: {
      mount: "/vite",
      bundle: "dist",
      devUrl: "http://127.0.0.1:5173",
    },
  });

  // Bundle store deliberately contains content that should NOT be
  // served — confirms the redirect runs before any read.
  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/vite-app/dist/index.html",
        { body: utf8("should-not-serve"), contentType: "text/html" },
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

  // Root request → trailing-slash form to keep dev-server router happy.
  const rootResponse = await runtime.fetch(
    new Request("http://localhost/vite", { redirect: "manual" }),
  );
  assert.equal(rootResponse.status, 307);
  assert.equal(
    rootResponse.headers.get("location"),
    "http://127.0.0.1:5173/",
  );
  assert.equal(rootResponse.headers.get("cache-control"), "no-cache");

  // Sub-path request → preserves the relative path.
  const assetResponse = await runtime.fetch(
    new Request("http://localhost/vite/src/main.ts", { redirect: "manual" }),
  );
  assert.equal(assetResponse.status, 307);
  assert.equal(
    assetResponse.headers.get("location"),
    "http://127.0.0.1:5173/src/main.ts",
  );

  // Querystring is preserved verbatim.
  const queryResponse = await runtime.fetch(
    new Request("http://localhost/vite/api/data?id=42&tab=auth", {
      redirect: "manual",
    }),
  );
  assert.equal(queryResponse.status, 307);
  assert.equal(
    queryResponse.headers.get("location"),
    "http://127.0.0.1:5173/api/data?id=42&tab=auth",
  );
});

test("app.devUrl can include its own base path that prefixes the relative path", async () => {
  // Common when the dev server itself is mounted under a sub-path
  // (e.g. `react-router dev --base /zelavis`) and zelavis needs to
  // redirect into that base.
  const plugin = definePlugin({
    name: "rr-app",
    scope: "system",
    app: {
      mount: "/zelavis",
      bundle: "dist",
      devUrl: "http://127.0.0.1:3001/zelavis",
    },
  });

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
    { bundleStore: createInMemoryBundleStore(new Map()) },
  );

  const runtime = await zelavisServer({ services });

  const rootResponse = await runtime.fetch(
    new Request("http://localhost/zelavis", { redirect: "manual" }),
  );
  assert.equal(rootResponse.status, 307);
  assert.equal(
    rootResponse.headers.get("location"),
    "http://127.0.0.1:3001/zelavis/",
  );

  const settingsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/settings?tab=auth", {
      redirect: "manual",
    }),
  );
  assert.equal(settingsResponse.status, 307);
  assert.equal(
    settingsResponse.headers.get("location"),
    "http://127.0.0.1:3001/zelavis/settings?tab=auth",
  );
});

test("app.devUrl bypasses bundle store and shell.render entirely", async () => {
  // If devUrl is configured, neither the bundle store nor any
  // configured shell.render should be invoked — the dev server is the
  // source of truth.
  const calls = { bundleReads: 0, shellRenders: 0 };

  const bundleStore = {
    async read() {
      calls.bundleReads += 1;
      return undefined;
    },
  };

  const plugin = definePlugin({
    name: "dual-mode",
    scope: "system",
    app: {
      mount: "/dual",
      bundle: "dist",
      devUrl: "http://127.0.0.1:5173",
      shell: {
        render: () => {
          calls.shellRenders += 1;
          return { body: "would-render" };
        },
      },
    },
  });

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

  await runtime.fetch(
    new Request("http://localhost/dual", { redirect: "manual" }),
  );
  await runtime.fetch(
    new Request("http://localhost/dual/x/y/z", { redirect: "manual" }),
  );

  assert.equal(calls.bundleReads, 0, "bundle store should not be read");
  assert.equal(calls.shellRenders, 0, "shell.render should not be invoked");
});

test("shell.render is called for index requests and SPA-fallback misses", async () => {
  const calls = [];
  const plugin = definePlugin({
    name: "shellful",
    scope: "system",
    app: {
      mount: "/app",
      bundle: "dist",
      mode: "spa",
      shell: {
        render: ({ request, path }) => {
          calls.push({ url: request.url, path });
          return {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><body data-rendered-path="${path}">shell</body>`,
          };
        },
      },
    },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/shellful/dist/assets/main.js",
        {
          body: utf8("console.log('main')"),
          contentType: "text/javascript; charset=utf-8",
        },
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

  // Root request — shell.render fires with empty path.
  const rootResponse = await runtime.fetch(new Request("http://localhost/app"));
  assert.equal(rootResponse.status, 200);
  assert.match(await rootResponse.text(), /data-rendered-path=""/);

  // Existing asset — bundle store wins, shell.render is NOT called.
  const assetResponse = await runtime.fetch(
    new Request("http://localhost/app/assets/main.js"),
  );
  assert.equal(assetResponse.status, 200);
  assert.match(await assetResponse.text(), /console\.log/);

  // Missing asset — shell.render fires as the SPA fallback, with the
  // unmatched path so the renderer can decide what to do.
  const fallbackResponse = await runtime.fetch(
    new Request("http://localhost/app/unknown/deep/path"),
  );
  assert.equal(fallbackResponse.status, 200);
  assert.match(
    await fallbackResponse.text(),
    /data-rendered-path="unknown\/deep\/path"/,
  );

  // shell.render was called twice (root + fallback), NOT for the asset
  // request that the bundle store handled.
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["", "unknown/deep/path"],
  );
});

test("shell.render can return non-200 for paths it wants to reject", async () => {
  const plugin = definePlugin({
    name: "gated",
    scope: "system",
    app: {
      mount: "/gated",
      bundle: "dist",
      mode: "spa",
      shell: {
        render: ({ path }) => {
          if (path.startsWith("api/")) {
            return {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: { error: "Not found" },
            };
          }
          return {
            status: 200,
            body: "<!doctype html>gated",
          };
        },
      },
    },
  });

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
    { bundleStore: createInMemoryBundleStore(new Map()) },
  );

  const runtime = await zelavisServer({ services });

  const apiResponse = await runtime.fetch(
    new Request("http://localhost/gated/api/v1/whatever"),
  );
  assert.equal(apiResponse.status, 404);
  assert.deepEqual(await apiResponse.json(), { error: "Not found" });

  const pageResponse = await runtime.fetch(
    new Request("http://localhost/gated/some-page"),
  );
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /gated/);
});

test("host-bound app routes only match the declared hostname", async () => {
  const plugin = definePlugin({
    name: "tenant",
    scope: "system",
    app: {
      mount: "/",
      bundle: "dist",
      domains: ["acme.example.com"],
    },
  });

  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/tenant/dist/index.html",
        {
          body: utf8("acme-home"),
          contentType: "text/html; charset=utf-8",
        },
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

  const matched = await runtime.fetch(
    new Request("http://acme.example.com/"),
  );
  assert.equal(matched.status, 200);
  assert.match(await matched.text(), /acme-home/);

  const rejected = await runtime.fetch(
    new Request("http://other.example.com/"),
  );
  assert.equal(rejected.status, 404);
});
