import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createDatabase } from "../dist/app/db/index.js";
import {
  createInMemoryBundleStore,
  Zelavis,
  zelavis,
} from "../dist/index.js";
import { ecommercePlugin } from "../../../plugins/ecommerce/dist/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const body =
      content instanceof Uint8Array ? content : encoder.encode(String(content));
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(body.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, Buffer.from(name), Buffer.from(body));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(body.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, Buffer.from(name));

    offset += local.byteLength + name.byteLength + body.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, end]));
}

test("zelavis exposes fetch handlers without requiring a mount adapter", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.rootPath, "/zelavis");
  assert.equal(payload.api.basePath, "/zelavis/api/v1");
  assert.deepEqual(
    payload.services.map((service) => service.name),
    [
      "@zelavis/ui",
      "zelavis/platform",
      "@zelavis/marketplace",
      "zelavis/fabric",
      "@zelavis/db",
      "zelavis/auth",
      "@zelavis/frontend",
      "@zelavis/workloads",
    ],
  );
  assert.deepEqual(payload.serviceRegistry, []);
});

test("zelavis includes core services by default", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend });
  const routes = runtime.routes;

  assert.equal(runtime.services["@zelavis/ui"].name, "@zelavis/ui");
  assert.equal(runtime.services["zelavis/platform"].name, "zelavis/platform");
  assert.equal(
    runtime.services["@zelavis/marketplace"].name,
    "@zelavis/marketplace",
  );
  assert.equal(
    runtime.services["zelavis/fabric"].name,
    "zelavis/fabric",
  );
  assert.equal(runtime.services["zelavis/auth"].name, "zelavis/auth");
  assert.equal(runtime.services["@zelavis/db"].name, "@zelavis/db");
  assert.equal(runtime.services["@zelavis/frontend"].name, "@zelavis/frontend");
  assert.ok(routes.some((route) => route.fullPath === "/*path"));
  assert.ok(routes.some((route) => route.fullPath === "/zelavis"));
  // The dashboard's view+asset+fallback used to register one route per
  // asset and an explicit route per client-side path (e.g.
  // `/zelavis/commerce/orders` from the ecommerce service's menu); now
  // everything under the dashboard mount is handled by a single
  // catch-all that serves bundle bytes or falls back to the shell
  // renderer for SPA deep links.
  assert.ok(routes.some((route) => route.fullPath === "/zelavis/*path"));
  assert.ok(
    routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/runtime/config",
    ),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/zelavis/api/v1/auth/providers"),
  );
  assert.ok(
    routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/database/health",
    ),
  );
  assert.ok(routes.some((route) => route.route.id === "auth.providers.list"));
  assert.ok(routes.some((route) => route.route.id === "database.health"));
  assert.ok(
    routes.some((route) => route.route.id === "database.collections.list"),
  );

  // Dashboard root: served by the synthesized app service via the
  // shell renderer, which injects the runtime config block.
  const dashboardResponse = await runtime.fetch(
    new Request("http://localhost/zelavis"),
  );
  assert.equal(dashboardResponse.status, 200);
  const dashboardBody = await dashboardResponse.text();
  assert.match(dashboardBody, /Zelavis Dashboard/);
  assert.match(dashboardBody, /__ZELAVIS_RUNTIME_CONFIG__/);
  // The Platform declares the mount and the bundle applies it, rather than the
  // Platform rewriting a router literal it had to know the shape of.
  assert.match(dashboardBody, /window\["__ZELAVIS_BASE_PATH__"\]="\/zelavis"/);
  assert.match(dashboardBody, /\/zelavis\/assets\//);
  assert.match(dashboardBody, /\?zelavis-runtime-v1/);
  assert.match(
    dashboardBody,
    /import\(["']\/zelavis\/assets\/entry\.client-[^"'?]+\.js\?zelavis-runtime-v1["']\)/,
  );
  assert.doesNotMatch(dashboardBody, /\/\/zelavis\/assets\//);
  assert.doesNotMatch(dashboardBody, /"\/assets\//);
  assert.doesNotMatch(
    dashboardBody,
    /import\(["']\/zelavis\/assets\/entry\.client-[^"'?]+\.js["']\)/,
  );

  // SPA deep-link: an unmatched client route is caught by `/zelavis/*path`
  // and falls back through `shell.render` to the same shell HTML.
  const settingsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/projects/project-a/settings"),
  );
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.text();
  assert.match(settingsBody, /window\["__ZELAVIS_BASE_PATH__"\]="\/zelavis"/);
  assert.match(settingsBody, /\/zelavis\/assets\//);

  // A bundle asset path is served by the catch-all reading from the
  // BundleStore, with the dashboard's content-type and no-cache header.
  const scriptAssetPath = (() => {
    const match = dashboardBody.match(
      /\/zelavis\/assets\/[A-Za-z0-9._-]+\.js(\?[^"'`)\s]*)?/,
    );
    return match ? match[0].replace(/\?.*$/, "") : undefined;
  })();
  assert.ok(scriptAssetPath, "expected a prefixed script asset in the shell");
  const scriptAssetResponse = await runtime.fetch(
    new Request(`http://localhost${scriptAssetPath}`),
  );
  assert.equal(scriptAssetResponse.status, 200);
  assert.equal(
    scriptAssetResponse.headers.get("cache-control"),
    "no-cache",
  );
  const scriptAssetBody = await scriptAssetResponse.text();
  assert.match(scriptAssetBody, /\/zelavis\/assets\//);
  assert.match(scriptAssetBody, /"\/zelavis\/assets\/[^"]+"/);
  assert.doesNotMatch(scriptAssetBody, /\/\/zelavis\/assets\//);
  assert.doesNotMatch(scriptAssetBody, /[`"']\/assets\//);
  assert.doesNotMatch(scriptAssetBody, /[`"']assets\//);

  // Unknown deep paths still get the SPA shell so the client router can
  // own routing, but unknown api/* paths get a real 404 from the
  // dashboard's shell renderer.
  const deepLinkResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/unknown/deep/path"),
  );
  assert.equal(deepLinkResponse.status, 200);
  assert.match(await deepLinkResponse.text(), /Zelavis Dashboard/);

  const unknownApiResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/unknown"),
  );
  assert.equal(unknownApiResponse.status, 404);
  assert.deepEqual(await unknownApiResponse.json(), { error: "Not found" });

  const configRoute = routes.find(
    (route) => route.fullPath === "/zelavis/api/v1/runtime/config",
  );
  const configResponse = await configRoute.route.handler({
    service: configRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.body.rootPath, "/zelavis");
  assert.equal(configResponse.body.api.basePath, "/zelavis/api/v1");
  assert.deepEqual(
    configResponse.body.services.map((service) => service.name),
    [
      "@zelavis/ui",
      "zelavis/platform",
      "@zelavis/marketplace",
      "zelavis/fabric",
      "@zelavis/db",
      "zelavis/auth",
      "@zelavis/frontend",
      "@zelavis/workloads",
    ],
  );
  assert.deepEqual(configResponse.body.serviceRegistry, []);
  assert.deepEqual(configResponse.body.runtime, {
    engine: "node",
    availableEngines: ["node", "bun", "deno"],
  });

  const pluginsRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/runtime/services" &&
      route.route.method === "GET",
  );
  const pluginsResponse = await pluginsRoute.route.handler({
    service: pluginsRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(pluginsResponse.status, 200);
  assert.deepEqual(pluginsResponse.body.services, []);

  const dashboardSettingsRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/runtime/settings" &&
      route.route.method === "GET",
  );
  const dashboardSettingsResponse = await dashboardSettingsRoute.route.handler({
    service: dashboardSettingsRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(dashboardSettingsResponse.status, 200);
  assert.equal(dashboardSettingsResponse.body.rootPath, "/zelavis");
  assert.equal(dashboardSettingsResponse.body.apiBasePath, "/zelavis/api/v1");
  assert.deepEqual(dashboardSettingsResponse.body.runtimeEngine, {
    current: "node",
    desired: "node",
    available: ["node", "bun", "deno"],
    restartRequired: false,
  });
  assert.equal(dashboardSettingsResponse.body.persistence, "runtime");
  assert.equal(dashboardSettingsResponse.body.restartRequired, false);
  assert.deepEqual(dashboardSettingsResponse.body.preferences, {});
  assert.deepEqual(dashboardSettingsResponse.body.editable, {
    rootPath: true,
    runtimeEngine: true,
    theme: true,
    pageBuilder: true,
  });

  const updateRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/runtime/settings" &&
      route.route.method === "PATCH",
  );
  const updateResponse = await updateRoute.route.handler({
    service: updateRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: {
      rootPath: "/admin",
      runtimeEngine: "bun",
      theme: "dark",
      preferences: {
        content: {
          pinnedTypes: ["articles"],
          labels: {
            articles: "Articles",
          },
        },
        media: {
          orderedPaths: ["media/hero.jpg"],
        },
      },
    },
    headers: {},
    request: undefined,
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.rootPath, "/zelavis");
  assert.equal(updateResponse.body.pendingRootPath, "/admin");
  assert.deepEqual(updateResponse.body.runtimeEngine, {
    current: "node",
    desired: "bun",
    available: ["node", "bun", "deno"],
    restartRequired: true,
  });
  assert.equal(updateResponse.body.theme, "dark");
  assert.equal(updateResponse.body.restartRequired, true);
  assert.deepEqual(updateResponse.body.preferences, {
    content: {
      pinnedTypes: ["articles"],
      labels: {
        articles: "Articles",
      },
    },
    media: {
      orderedPaths: ["media/hero.jpg"],
    },
  });

  const invalidUpdateResponse = await updateRoute.route.handler({
    service: updateRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: {
      theme: "violet",
    },
    headers: {},
    request: undefined,
  });

  assert.equal(invalidUpdateResponse.status, 400);
  assert.match(invalidUpdateResponse.body.error, /Theme must be/);

  const invalidRuntimeEngineResponse = await updateRoute.route.handler({
    service: updateRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: {
      runtimeEngine: "workerd",
    },
    headers: {},
    request: undefined,
  });

  assert.equal(invalidRuntimeEngineResponse.status, 400);
  assert.match(invalidRuntimeEngineResponse.body.error, /Runtime engine must be/);
});

test("privileged project control routes declare explicit access requirements", async () => {
  const storage = {
    async list() { return []; },
    async get() { return undefined; },
    async put(input) {
      return { ...input, size: input.body.byteLength, updatedAt: new Date() };
    },
    async delete() { return true; },
  };
  const runtime = await zelavis({
    // `dashboard: false` alongside a factory used to mean "no frontend"; the
    // factory was supplied and then ignored. `frontend: false` says it once.
    subsystems: {
      auth: false,
      database: false,
      site: true,
      storage: { storage },
    },
  });
  const routes = new Map(runtime.routes.map((route) => [route.route.id, route.route]));
  const permissions = {
    "storage.files.list": "storage.read",
    "storage.files.write": "storage.write",
    "storage.files.delete": "storage.write",
    "workloads.menu": "workloads.view",
    "workloads.list": "workloads.view",
    "workloads.create": "workloads.manage",
    "workloads.read": "workloads.view",
    "workloads.update": "workloads.manage",
    "workloads.run": "workloads.manage",
    "workloads.logs": "workloads.logs.read",
  };

  for (const [id, permission] of Object.entries(permissions)) {
    assert.deepEqual(routes.get(id)?.access, { permissions: [permission] }, id);
  }
  assert.deepEqual(routes.get("runtime.service-page-asset.read")?.access, {
    authenticated: true,
  });
  assert.deepEqual(routes.get("runtime.deployment-backends.list")?.access, {
    permissions: ["server.backends.view"],
  });
  for (const id of [
    "runtime.agent.read",
    "runtime.agent.operations.list",
    "runtime.agent.operations.get",
  ]) {
    assert.deepEqual(routes.get(id)?.access, {
      permissions: ["server.agents.view"],
    });
  }
  for (const action of ["detect", "enable", "disable", "default"]) {
    assert.deepEqual(routes.get(`runtime.deployment-backends.${action}`)?.access, {
      permissions: ["server.backends.manage"],
    });
  }
  // The Project's public front door stays an explicit public data-plane route.
  assert.equal(routes.get("project.frontend.placeholder")?.access, undefined);
  assert.equal(routes.get("storage.files.read")?.access, undefined);
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    assert.equal(routes.get(`workloads.http.${method}`)?.access, undefined);
  }

  await runtime.close();
});

test("auth method plugins register through the public auth capability", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    serviceRegistry: {
      catalog: [
        {
          service: {
            name: "@example/test-auth-provider",
            kind: "provider",
            capabilities: ["zelavis/auth:credentials"],
            service: {
              name: "test-auth",
              register(api) {
                api.authentication.registerProvider({
                  name: "@example/test-auth-provider",
                  async authenticate() {
                    throw new Error("not used by this provider discovery test");
                  },
                });
              },
            },
          },
          status: "installed",
        },
      ],
    },
  });

  const providersResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/auth/providers"),
  );
  const providers = await providersResponse.json();

  assert.equal(providersResponse.status, 200);
  assert.deepEqual(providers, ["@example/test-auth-provider"]);
  assert.equal(
    runtime.routes.some((route) => route.route.id === "@example/test-auth-provider"),
    false,
    "auth method plugins need no private top-level route",
  );
});

test("service registry install state controls service activation on boot", async () => {
  const storeState = [
    {
      name: "@zelavis/ecommerce",
      status: "installed",
      order: 0,
    },
  ];
  const encoder = new TextEncoder();
  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/@zelavis/ecommerce/dashboard/dashboard.html",
        {
          body: encoder.encode("<!doctype html><title>Ecommerce</title><main>Commerce workspace</main>"),
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "system/@zelavis/ecommerce/dashboard/placeholder.css",
        {
          body: encoder.encode("main { display: grid; }"),
          contentType: "text/css; charset=utf-8",
        },
      ],
    ]),
  );
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    bundleStore,
    serviceRegistry: {
      catalog: [
        {
          service: ecommercePlugin,
          status: "installed",
          source: "official",
          order: 0,
        },
      ],
      store: {
        read() {
          return storeState;
        },
        write(entries) {
          storeState.splice(0, storeState.length, ...entries);
          return entries;
        },
      },
    },
  });

  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/commerce/health",
    ),
  );

  const configResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await configResponse.json();

  assert.equal(config.serviceRegistry[0].status, "installed");
  assert.equal(
    config.serviceRegistry[0].menu.page.src,
    "/zelavis/api/v1/runtime/service-page-assets/%40zelavis%2Fecommerce/dashboard/dashboard.html",
  );
  assert.ok(config.services.some((service) => service.name === "commerce"));

  const servicePageResponse = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40zelavis%2Fecommerce/dashboard/dashboard.html",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const servicePage = await servicePageResponse.text();

  assert.equal(servicePageResponse.status, 200);
  assert.match(servicePageResponse.headers.get("content-type"), /text\/html/);
  assert.match(servicePage, /Commerce workspace/);
});

test("dashboard service registry can register ESM service sources", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend });
  const specifier =
    "data:text/javascript," +
    encodeURIComponent(`
      export default {
        name: "@example/uploaded-service",
        version: "0.0.1",
        menu: {
          title: "Uploaded",
          path: "/uploaded"
        }
      };
    `);

  const createResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        specifier,
      }),
    }),
    PLATFORM_OWNER_CONTEXT,
  );
  const created = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.ok(
    created.services.some(
      (service) =>
        service.name === "@example/uploaded-service" &&
        service.specifier === specifier &&
        service.status === "available",
    ),
  );

  const storeState = [
    {
      name: "@example/uploaded-service",
      specifier,
      status: "installed",
      source: "community",
    },
  ];
  const loadedRuntime = await zelavis({
    frontend: zelavisUiFrontend,
    serviceRegistry: {
      store: {
        read() {
          return storeState;
        },
        write(entries) {
          storeState.splice(0, storeState.length, ...entries);
          return entries;
        },
      },
    },
  });
  const configResponse = await loadedRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await configResponse.json();
  const uploadedService = config.serviceRegistry.find(
    (service) => service.name === "@example/uploaded-service",
  );

  assert.equal(uploadedService.status, "installed");
  assert.equal(uploadedService.specifier, specifier);
  assert.equal(uploadedService.menu.path, "/uploaded");
});

test("service dashboard pages can be static HTML files from service bundles", async () => {
  const encoder = new TextEncoder();
  const service = {
    name: "@example/static-pages",
    menu: {
      title: "Static Pages",
      path: "/static-pages",
      page: {
        id: "settings",
        title: "Settings",
        file: "settings.html",
      },
    },
  };
  const bundleStore = createInMemoryBundleStore(
    new Map([
      [
        "system/@example/static-pages/dist/settings.html",
        {
          body: encoder.encode(
            '<!doctype html><html><body><main>Static settings page</main><script type="module" src="./settings.js"></script></body></html>',
          ),
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "system/@example/static-pages/dist/settings.js",
        {
          body: encoder.encode("export const ok = true;"),
          contentType: "text/javascript; charset=utf-8",
        },
      ],
    ]),
  );
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    bundleStore,
    serviceRegistry: {
      catalog: [
        {
          service,
          status: "installed",
        },
      ],
    },
  });

  const configResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await configResponse.json();

  assert.equal(config.serviceRegistry[0].menu.page.file, "settings.html");
  assert.equal(
    config.serviceRegistry[0].menu.page.src,
    "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fstatic-pages/dist/settings.html",
  );

  const response = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fstatic-pages/dist/settings.html",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /Static settings page/);

  const scriptResponse = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-page-assets/%40example%2Fstatic-pages/dist/settings.js",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const script = await scriptResponse.text();

  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
  assert.match(script, /ok = true/);
});

test("dashboard service upload derives metadata from the selected module", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend });
  const form = new FormData();

  form.set(
    "file",
    new Blob(
      [
        `
          export default {
            name: "@example/picked-service",
            version: "0.0.2",
            menu: {
              title: "Picked",
              path: "/picked"
            }
          };
        `,
      ],
      { type: "text/javascript" },
    ),
    "picked-service.mjs",
  );

  const createResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      body: form,
    }),
    PLATFORM_OWNER_CONTEXT,
  );
  const created = await createResponse.json();
  const service = created.services.find(
    (service) => service.name === "@example/picked-service",
  );

  assert.equal(createResponse.status, 201);
  assert.equal(service.version, "0.0.2");
  assert.equal(service.status, "available");
  assert.match(service.specifier, /^data:text\/javascript;base64,/);
});

test("Zelavis instance recomposes runtime after service activation", async () => {
  const specifier =
    "data:text/javascript," +
    encodeURIComponent(`
      export default {
        name: "@example/runtime-uploaded-service",
        version: "0.0.1",
        menu: {
          title: "Runtime Uploaded",
          path: "/runtime-uploaded"
        },
        setup() {
          return {
            runtimeServices: [
              {
                name: "runtime-uploaded",
                basePath: "/runtime-uploaded",
                service: {},
                api: {
                  v1: [
                    {
                      id: "runtime-uploaded.health",
                      method: "GET",
                      path: "/health",
                      handler: () => ({
                        status: 200,
                        body: { ok: true }
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    `);
  const app = new Zelavis();

  const createResponse = await app.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "@example/runtime-uploaded-service",
        specifier,
        status: "installed",
      }),
    }),
    PLATFORM_OWNER_CONTEXT,
  );
  const created = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.equal(created.activation.status, "active");

  const configResponse = await app.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await configResponse.json();

  assert.equal(configResponse.status, 200);
  assert.equal(config.serviceActivation.mode, "runtime");
  assert.equal(config.serviceActivation.capabilities.strategy, "runtime-graph");
  assert.equal(
    config.serviceActivation.capabilities.supportsRuntimeInstall,
    true,
  );
  assert.equal(
    config.serviceActivation.capabilities.supportsUploadedSpecifiers,
    true,
  );

  const healthResponse = await app.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime-uploaded/health"),
  );
  const health = await healthResponse.json();

  assert.equal(healthResponse.status, 200);
  assert.deepEqual(health, { ok: true });
});

test("node adapter resolves uploaded service paths through its service cache importer", async () => {
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const tempDirectory = await mkdtemp(join(tmpdir(), "zelavis-node-service-"));

  try {
    const servicePath = join(tempDirectory, "uploaded-service.mjs");
    await writeFile(
      servicePath,
      `
        export default {
          name: "@example/node-uploaded-service",
          version: "0.0.1",
          menu: {
            title: "Node Uploaded",
            path: "/node-uploaded",
            items: [
              {
                title: "Settings",
                path: "/node-uploaded/settings"
              }
            ]
          },
          setup() {
            return {
              runtimeServices: [
                {
                  name: "node-uploaded",
                  basePath: "/node-uploaded",
                  service: {},
                  api: {
                    v1: [
                      {
                        id: "node-uploaded.health",
                        method: "GET",
                        path: "/health",
                        handler: () => ({
                          status: 200,
                          body: { ok: true, source: "node-service-cache" }
                        })
                      }
                    ]
                  }
                }
              ]
            };
          }
        };
      `,
    );

    const app = new Zelavis({
      // Registering a service by absolute path executes code from outside the
      // Platform's managed service directory, so the host must opt in.
      adapter: nodeAdapter({
        dataDirectory: tempDirectory,
        services: { sources: { filesystem: true } },
      }),
    });

    const createResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/services", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          specifier: servicePath,
          status: "installed",
        }),
      }),
      PLATFORM_OWNER_CONTEXT,
    );
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.activation.status, "active");

    const healthResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/node-uploaded/health"),
    );
    const health = await healthResponse.json();

    assert.equal(healthResponse.status, 200);
    assert.deepEqual(health, { ok: true, source: "node-service-cache" });

    const configResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/config"),
    );
    const config = await configResponse.json();
    const uploadedMenu = config.serviceRegistry.find(
      (entry) => entry.name === "@example/node-uploaded-service",
    )?.menu;

    assert.equal(uploadedMenu.path, "/node-uploaded");
    assert.equal(uploadedMenu.page, undefined);
    assert.equal(uploadedMenu.items[0].path, "/node-uploaded/settings");
    assert.equal(uploadedMenu.items[0].page, undefined);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("a service package without package.json is refused", async () => {
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const tempDirectory = await mkdtemp(join(tmpdir(), "zelavis-legacy-service-"));

  try {
    const app = new Zelavis({
      adapter: nodeAdapter({ dataDirectory: tempDirectory }),
    });
    // The retired sidecar must not be honoured: configuration lives in
    // package.json under the `zelavis` namespace.
    const packageBytes = createStoredZip({
      "zelavis.service.json": JSON.stringify({ entry: "./dist/index.mjs" }),
      "dist/index.mjs": "export default { name: \"@example/legacy\", api: {} };\n",
    });

    const response = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/services/packages", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-zelavis-file-name": "legacy-service.zip",
        },
        body: packageBytes,
      }),
      PLATFORM_OWNER_CONTEXT,
    );

    assert.notEqual(
      response.status,
      201,
      "a package configured only by zelavis.service.json must not install",
    );
    await app.close();
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("node adapter installs uploaded ZIP service packages", async () => {
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const tempDirectory = await mkdtemp(join(tmpdir(), "zelavis-node-package-"));

  try {
    const app = new Zelavis({
      adapter: nodeAdapter({ dataDirectory: tempDirectory }),
    });
    const packageBytes = createStoredZip({
      // Service packages are configured through package.json, the same as any
      // other npm package; the retired zelavis.service.json is not read.
      "package.json": JSON.stringify({
        name: "@example/zip-uploaded-service",
        version: "0.0.3",
        type: "module",
        exports: "./dist/index.mjs",
        zelavis: { kind: "plugin" },
      }),
      "dist/index.mjs": `
        export default {
          name: "@example/zip-uploaded-service",
          version: "0.0.3",
          menu: {
            title: "Zip Uploaded",
            path: "/zip-uploaded"
          },
          setup() {
            return {
              runtimeServices: [
                {
                  name: "zip-uploaded",
                  basePath: "/zip-uploaded",
                  service: {},
                  api: {
                    v1: [
                      {
                        id: "zip-uploaded.health",
                        method: "GET",
                        path: "/health",
                        handler: () => ({
                          status: 200,
                          body: { ok: true, source: "zip-package" }
                        })
                      }
                    ]
                  }
                }
              ]
            };
          }
        };
      `,
    });
    const form = new FormData();
    form.set(
      "file",
      new Blob([packageBytes], { type: "application/zip" }),
      "zip-uploaded-service.zip",
    );
    form.set("status", "installed");

    const configResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/config"),
    );
    const config = await configResponse.json();

    assert.equal(
      config.serviceActivation.capabilities.supportsPackageUploads,
      true,
    );

    const createResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/services", {
        method: "POST",
        body: form,
      }),
      PLATFORM_OWNER_CONTEXT,
    );
    const created = await createResponse.json();
    const service = created.services.find(
      (service) => service.name === "@example/zip-uploaded-service",
    );

    assert.equal(createResponse.status, 201);
    assert.equal(created.activation.status, "active");
    assert.equal(service.version, "0.0.3");
    assert.equal(service.status, "installed");
    assert.match(service.specifier, /services\/packages\/[a-f0-9]{64}\/dist\/index\.mjs$/);

    const healthResponse = await app.fetch(
      new Request("http://localhost/zelavis/api/v1/zip-uploaded/health"),
    );
    const health = await healthResponse.json();

    assert.equal(healthResponse.status, 200);
    assert.deepEqual(health, { ok: true, source: "zip-package" });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("zelavis can disable the database core service", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    subsystems: {
      database: false,
    },
  });

  assert.equal(runtime.services["zelavis/auth"].name, "zelavis/auth");
  assert.equal(runtime.services["@zelavis/frontend"].name, "@zelavis/frontend");
  assert.equal(runtime.services["@zelavis/db"], undefined);
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("database.")),
  );
});

test("zelavis can disable the auth core service", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    subsystems: {
      auth: false,
    },
  });

  assert.equal(runtime.services["zelavis/auth"], undefined);
  assert.equal(runtime.services["@zelavis/db"].name, "@zelavis/db");
  assert.equal(runtime.services["@zelavis/frontend"].name, "@zelavis/frontend");
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("auth.")),
  );
});

test("the frontend cannot be switched off in code", async () => {
  // There is no `frontend: false`. Having no frontend is expressed by
  // installing none, and a second code-level switch meant the same thing twice
  // — a factory could be supplied and then silently ignored.
  const withFrontend = await zelavis({ frontend: zelavisUiFrontend });
  const withoutFrontend = await zelavis({});

  // Whichever it is, the root path answers and the API is identical.
  for (const runtime of [withFrontend, withoutFrontend]) {
    const root = await runtime.fetch(new Request("http://localhost/zelavis/"));
    assert.equal(root.status, 200);
    const config = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/config"),
    );
    assert.equal(config.status, 200);
    assert.equal(runtime.services["zelavis/auth"].name, "zelavis/auth");
  }

  assert.match(await (await withFrontend.fetch(
    new Request("http://localhost/zelavis/"),
  )).text(), /Loading Zelavis dashboard/u);
  assert.match(await (await withoutFrontend.fetch(
    new Request("http://localhost/zelavis/"),
  )).text(), /No frontend installed/u);
});

test("zelavis uses a configurable root path for dashboard and APIs", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    rootPath: "/admin",
    api: {
      version: "v2",
    },
  });
  const routes = runtime.routes;

  // Dashboard mounting points still appear in the route table — the
  // index + a catch-all that picks up all sub-paths (asset serving and
  // SPA-deep-link fallback) — and the API endpoints stay explicit.
  assert.ok(routes.some((route) => route.fullPath === "/admin"));
  assert.ok(routes.some((route) => route.fullPath === "/admin/*path"));
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/runtime/config"),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/auth/providers"),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/database/health"),
  );

  // Shell at the dashboard root, exercised end-to-end through the
  // dispatcher — should embed the runtime config and prefix all
  // `/assets/...` references with the configured root path.
  const dashboardResponse = await runtime.fetch(
    new Request("http://localhost/admin"),
  );
  assert.equal(dashboardResponse.status, 200);
  const dashboardBody = await dashboardResponse.text();
  assert.match(dashboardBody, /\/admin\/assets\//);
  assert.match(dashboardBody, /window\["__ZELAVIS_BASE_PATH__"\]="\/admin"/);
  assert.match(dashboardBody, /\?zelavis-runtime-v1/);
  assert.match(
    dashboardBody,
    /import\(["']\/admin\/assets\/entry\.client-[^"'?]+\.js\?zelavis-runtime-v1["']\)/,
  );
  assert.doesNotMatch(dashboardBody, /\/\/admin\/assets\//);
  assert.doesNotMatch(dashboardBody, /"\/assets\//);
  assert.doesNotMatch(
    dashboardBody,
    /import\(["']\/admin\/assets\/entry\.client-[^"'?]+\.js["']\)/,
  );

  // Pick any script asset out of the bundle and fetch it through the
  // catch-all. The bundle store applies the same `/admin/assets/`
  // prefixing to its contents.
  const manifestAssetPath = collectScriptAssetPath(dashboardBody);
  assert.ok(manifestAssetPath, "should reference at least one prefixed asset");
  const scriptAssetResponse = await runtime.fetch(
    new Request(`http://localhost${manifestAssetPath.replace(/\?.*$/, "")}`),
  );
  assert.equal(scriptAssetResponse.status, 200);
  assert.equal(
    scriptAssetResponse.headers.get("cache-control"),
    "no-cache",
  );
  const scriptAssetBody = await scriptAssetResponse.text();
  assert.match(scriptAssetBody, /\/admin\/assets\//);
  assert.doesNotMatch(scriptAssetBody, /\/\/admin\/assets\//);
  assert.doesNotMatch(scriptAssetBody, /[`"']\/assets\//);
  assert.doesNotMatch(scriptAssetBody, /[`"']assets\//);
});

function collectScriptAssetPath(html) {
  const match = html.match(/\/admin\/assets\/[A-Za-z0-9._-]+\.js(\?[^"'`)\s]*)?/);
  return match ? match[0] : undefined;
}

test("zelavis supports mounting at the root path when explicitly configured", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    rootPath: "/",
  });

  assert.ok(runtime.routes.some((route) => route.fullPath === "/"));
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/api/v1/runtime/config",
    ),
  );

  const response = await runtime.fetch(
    new Request("http://localhost/api/v1/runtime/config"),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.rootPath, "/");
  assert.equal(payload.api.basePath, "/api/v1");
});

test("zelavis can redirect dashboard routes to a UI dev server", async () => {
  const runtime = await zelavis({
    frontend: {
      factory: zelavisUiFrontend,
      devServerUrl: "http://127.0.0.1:3001",
    },
  });

  const settingsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/projects/project-a/settings?tab=auth", {
      redirect: "manual",
    }),
  );
  assert.equal(settingsResponse.status, 307);
  assert.equal(
    settingsResponse.headers.get("location"),
    "http://127.0.0.1:3001/projects/project-a/settings?tab=auth",
  );

  const nestedResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/nested/panel", {
      redirect: "manual",
    }),
  );
  assert.equal(nestedResponse.status, 307);
  assert.equal(
    nestedResponse.headers.get("location"),
    "http://127.0.0.1:3001/nested/panel",
  );

  const apiResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config", {
      redirect: "manual",
    }),
  );
  assert.equal(apiResponse.status, 200);
  assert.equal(apiResponse.headers.get("location"), null);

  // No per-asset routes are registered when the dev server short-circuit
  // is active — the synthesized `/zelavis/*path` route handles everything.
  assert.ok(
    runtime.routes.every(
      (route) => !route.route.id.startsWith("dashboard.assets"),
    ),
  );
});

test("zelavis preserves a mounted dev-server dashboard base path", async () => {
  const runtime = await zelavis({
    frontend: {
      factory: zelavisUiFrontend,
      devServerUrl: "http://127.0.0.1:3001/zelavis",
    },
  });

  const rootResponse = await runtime.fetch(
    new Request("http://localhost/zelavis", { redirect: "manual" }),
  );
  assert.equal(rootResponse.status, 307);
  assert.equal(
    rootResponse.headers.get("location"),
    "http://127.0.0.1:3001/zelavis/",
  );

  const settingsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/projects/project-a/settings?tab=auth", {
      redirect: "manual",
    }),
  );
  assert.equal(settingsResponse.status, 307);
  assert.equal(
    settingsResponse.headers.get("location"),
    "http://127.0.0.1:3001/zelavis/projects/project-a/settings?tab=auth",
  );
});

test("zelavis keeps the Platform server control plane when optional mounted services are disabled", async () => {
  const runtime = await zelavis({
    subsystems: {
      auth: false,
      database: false,
      site: false,
      workloads: false,
    },
  });

  // The front-door page is always present: having no frontend is a state the
  // installation explains, not one it can be configured out of.
  assert.deepEqual(Object.keys(runtime.services), [
    "@zelavis/no-frontend",
    "zelavis/platform",
    "@zelavis/marketplace",
    "zelavis/fabric",
  ]);
  assert.deepEqual(
    runtime.routes.map((route) => route.route.id).filter(
      (id) => id !== "platform.frontend.missing",
    ),
    [
      "runtime.config",
      "runtime.services.read",
      "runtime.services.create",
      "runtime.service-page-styles.read",
      "runtime.service-page-asset.read",
      "runtime.services.update",
      "runtime.settings.read",
      "runtime.settings.update",
      "runtime.openapi.bare",
      "runtime.openapi",
      "runtime.agent.read",
      "runtime.agent.operations.list",
      "runtime.agent.operations.get",
      "runtime.deployment-backends.list",
      "runtime.deployment-backends.detect",
      "runtime.deployment-backends.enable",
      "runtime.deployment-backends.disable",
      "runtime.deployment-backends.default",
      "runtime.access",
      "runtime.project-recipes.list",
      "runtime.assistant.threads.list",
      "runtime.assistant.threads.create",
      "runtime.assistant.threads.get",
      "runtime.assistant.messages.create",
      "runtime.projects.list",
      "runtime.projects.create",
      "runtime.projects.get",
      "runtime.projects.start",
      "runtime.projects.stop",
      "runtime.projects.restart",
      "runtime.projects.logs",
      "runtime.projects.proxy.get",
      "runtime.projects.proxy.post",
      "runtime.projects.proxy.put",
      "runtime.projects.proxy.patch",
      "runtime.projects.proxy.delete",
      "runtime.projects.remove",
      "fabric.snapshot",
      "fabric.health",
      "fabric.nodes.list",
      "fabric.nodes.get",
      "fabric.project-placements.list",
      "fabric.project-placements.get",
      "fabric.project-placements.plan",
      "fabric.migrations.list",
    ],
  );

  const fabricResponse = await runtime.plain({
    url: "/zelavis/api/v1/fabric/snapshot",
    principal: { id: "owner", type: "system", permissions: ["fabric.view"] },
  });
  assert.equal(fabricResponse.status, 200);
  assert.deepEqual(fabricResponse.body, {
    authority: {
      scope: "platform",
      scopeId: "local-platform",
      capabilities: ["hosting:projects", "hosting:fabric"],
    },
    mode: "single-node",
    status: "ready",
    localNodeId: "local",
    nodes: [
      {
        id: "local",
        status: "ready",
        roles: ["gateway", "control", "worker"],
        runtimeEngine: "node",
        runtimeDriver: "local",
      },
    ],
    projectPlacements: [],
    migrations: [],
    features: {
      projectPlacement: "available",
      multiNode: "planned",
      automaticBalancing: "planned",
      projectMigration: "planned",
      zelavisAppDataPlacement: "planned",
      replication: "planned",
      infrastructureAutoscaling: "planned",
    },
  });
});

test("zelavis uses a configured Fabric placement list for point lookups", async () => {
  const placement = {
    identity: {
      scopeId: "platform-a",
      workloadId: "external-project",
      type: "project",
    },
    projectKind: "generic",
    runtimeNodeId: "local",
    generation: 4,
    state: "active",
    runtimeStatus: "running",
  };
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    subsystems: {
      fabric: {
        authority: {
          scope: "platform",
          scopeId: "platform-a",
          capabilities: ["hosting:projects", "hosting:fabric"],
        },
        inventory: {
          projectPlacements: () => [placement],
        },
      },
    },
  });

  try {
    const response = await runtime.plain({
      url: "/zelavis/api/v1/fabric/placements/projects/external-project",
      principal: { id: "owner", type: "system", permissions: ["fabric.view"] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { placement });
  } finally {
    await runtime.close();
  }
});

test("zelavis rejects obsolete direct runtime service options", async () => {
  await assert.rejects(
    () =>
      zelavis({
    frontend: zelavisUiFrontend,
        runtimeServices: [
          {
            name: "@example/obsolete",
            service: {},
            api: { v1: [] },
          },
        ],
      }),
    /no longer accepts direct service options/,
  );
});




test("zelavis rejects invalid persisted dashboard settings on read", async () => {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    // The settings store is a resource, not a frontend field: an installation
    // serving no frontend still persists its own settings.
    runtimeSettingsStore: {
      async read() {
        return { theme: "violet" };
      },
      async write(update) {
        return update;
      },
    },
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/settings"),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Stored dashboard theme must be one of/);
});

test("a Project without a frontend serves a placeholder rather than a 404", async () => {
  const runtime = await zelavis({
    role: "project",
    subsystems: { auth: false, database: false, site: true },
  });

  const response = await runtime.fetch(new Request("http://localhost/"));
  // 503, not 200: the Project is reachable but cannot serve content yet, and
  // the placeholder must not be indexed as if it were the site.
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.text();
  assert.match(body, /has no frontend yet/);
  assert.match(body, /noindex/);
});

test("the frontend placeholder leaves control-plane paths alone", async () => {
  const runtime = await zelavis({
    role: "project",
    subsystems: { auth: false, database: false, site: true },
  });

  // A mistyped API path must keep its own 404 rather than being answered with
  // a page, or every bad request looks like a working site.
  for (const path of ["/zelavis/api/v1/nope", "/zelavis/nope"]) {
    const response = await runtime.fetch(new Request(`http://localhost${path}`));
    assert.notEqual(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
      `${path} must not be served the placeholder`,
    );
  }
});

test("the frontend placeholder escapes its title", async () => {
  const { renderProjectFrontendPlaceholder } = await import(
    "../dist/platform/project-frontend.js"
  );
  const html = renderProjectFrontendPlaceholder({ title: 'Ann & <script>"x"' });
  assert.match(html, /Ann &amp; &lt;script&gt;&quot;x&quot;/);
  assert.ok(!html.includes("<script>"), "the title must not inject markup");
});

test("an installation running the dashboard uses it as its default frontend", async () => {
  const runtime = await zelavis({ subsystems: { auth: false, database: false } });

  // `/` must lead somewhere. The outermost installation is its own product, so
  // its default frontend is the dashboard rather than a page explaining that
  // nothing is installed.
  const response = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/zelavis");

  const dashboard = await runtime.fetch(new Request("http://localhost/zelavis"));
  assert.equal(dashboard.status, 200);
});

test("a Project runtime falls back to the placeholder, not the dashboard", async () => {
  // A Project exists to host something that has not been chosen yet, so `/`
  // serves its own placeholder rather than bouncing to a Platform page.
  const runtime = await zelavis({
    role: "project",
    subsystems: { auth: false, database: false },
  });

  const response = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /has no frontend yet/);
});

test("the default frontend never shadows control-plane paths", async () => {
  for (const dashboard of [true, false]) {
    const runtime = await zelavis({
    frontend: zelavisUiFrontend,
      frontend: dashboard,
    subsystems: { auth: false, database: false },
    });
    const response = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/nope"),
    );
    assert.equal(
      response.status,
      404,
      `a mistyped API path must keep its own 404 (dashboard: ${dashboard})`,
    );
  }
});
