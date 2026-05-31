import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createDatabase } from "@zelavis/db";
import { defineService, Zelavis, zelavis } from "../dist/index.js";
import { zelavisEcommerceService } from "../../../plugins/ecommerce/dist/index.js";

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
  const runtime = await zelavis({});

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.rootPath, "/zelavis");
  assert.equal(payload.api.basePath, "/zelavis/api/v1");
  assert.deepEqual(
    payload.services.map((service) => service.name),
    ["@zelavis/ui", "@zelavis/db", "@zelavis/auth", "@zelavis/website"],
  );
  assert.equal(payload.serviceRegistry[0].name, "@zelavis/ecommerce");
  assert.equal(payload.serviceRegistry[0].status, "available");
});

test("zelavis includes core services by default", async () => {
  const runtime = await zelavis({});
  const routes = runtime.routes;

  assert.equal(runtime.services["@zelavis/ui"].name, "@zelavis/ui");
  assert.equal(runtime.services["@zelavis/auth"].name, "@zelavis/auth");
  assert.equal(runtime.services["@zelavis/db"].name, "@zelavis/db");
  assert.equal(runtime.services["@zelavis/website"].name, "@zelavis/website");
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
  assert.match(dashboardBody, /"basename":"\/zelavis"/);
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
    new Request("http://localhost/zelavis/settings"),
  );
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.text();
  assert.match(settingsBody, /"basename":"\/zelavis"/);
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
    ["@zelavis/ui", "@zelavis/db", "@zelavis/auth", "@zelavis/website"],
  );
  assert.equal(configResponse.body.serviceRegistry.length, 1);
  assert.equal(configResponse.body.serviceRegistry[0].name, "@zelavis/ecommerce");
  assert.equal(configResponse.body.serviceRegistry[0].status, "available");
  assert.equal(configResponse.body.serviceRegistry[0].menu.items[0].path, "/commerce/products");

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
  assert.equal(pluginsResponse.body.services[0].status, "available");

  const updatePluginRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/runtime/services/:name" &&
      route.route.method === "PATCH",
  );
  const updatePluginResponse = await updatePluginRoute.route.handler({
    service: updatePluginRoute.service.service,
    params: { name: "@zelavis/ecommerce" },
    query: new URLSearchParams(),
    body: {
      status: "installed",
      order: 3,
    },
    headers: {},
    request: undefined,
  });

  assert.equal(updatePluginResponse.status, 200);
  assert.equal(updatePluginResponse.body.services[0].status, "installed");
  assert.equal(updatePluginResponse.body.services[0].order, 3);

  const configResponseAfterPluginUpdate = await configRoute.route.handler({
    service: configRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(
    configResponseAfterPluginUpdate.body.serviceRegistry[0].status,
    "installed",
  );

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
  assert.equal(dashboardSettingsResponse.body.persistence, "runtime");
  assert.equal(dashboardSettingsResponse.body.restartRequired, false);
  assert.deepEqual(dashboardSettingsResponse.body.preferences, {});
  assert.deepEqual(dashboardSettingsResponse.body.editable, {
    rootPath: true,
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
});

test("auth provider child services extend the built-in auth service", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: {
        childServices: ["@example/test-auth-provider"],
      },
    },
    services: {
      entries: [
        {
          service: defineService({
            name: "@example/test-auth-provider",
            extends: "@zelavis/auth",
            setup(api) {
              api.authentication.registerProvider({
                name: "@example/test-auth-provider",
                async authenticate(input) {
                  return {
                    account: await api.accounts.create({
                      id: String(input.accountId ?? "acc_test"),
                      email: "test@example.com",
                    }),
                  };
                },
              });
            },
          }),
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
    "auth child services should not mount as top-level runtime routes",
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
  const runtime = await zelavis({
    services: {
      entries: [
        {
          service: zelavisEcommerceService,
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
    "/zelavis/api/v1/runtime/service-pages/%40zelavis%2Fecommerce/dashboard",
  );
  assert.ok(config.services.some((service) => service.name === "commerce"));

  const servicePageResponse = await runtime.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/service-pages/%40zelavis%2Fecommerce/dashboard",
    ),
  );
  const servicePage = await servicePageResponse.text();

  assert.equal(servicePageResponse.status, 200);
  assert.match(
    servicePageResponse.headers.get("content-type"),
    /text\/html/,
  );
  assert.match(servicePage, /<!doctype html>/i);
  assert.match(servicePage, /<title>Ecommerce<\/title>/);
});

test("dashboard service registry can register ESM service sources", async () => {
  const runtime = await zelavis({});
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
    services: {
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

test("dashboard service upload derives metadata from the selected module", async () => {
  const runtime = await zelavis({});
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
            page: {
              id: "dashboard",
              title: "Node Uploaded",
              render: () => "<!doctype html><html><head><title>Node Uploaded</title></head><body><main>Node uploaded service page</main></body></html>"
            }
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
      adapter: nodeAdapter({ dataDirectory: tempDirectory }),
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

    const servicePageResponse = await app.fetch(
      new Request(
        "http://localhost/zelavis/api/v1/runtime/service-pages/%40example%2Fnode-uploaded-service/dashboard",
      ),
    );
    const servicePage = await servicePageResponse.text();

    assert.equal(servicePageResponse.status, 200);
    assert.match(servicePage, /Node uploaded service page/);
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
      "zelavis.service.json": JSON.stringify({
        entry: "./dist/index.mjs",
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
    coreServices: {
      database: false,
    },
  });

  assert.equal(runtime.services["@zelavis/auth"].name, "@zelavis/auth");
  assert.equal(runtime.services["@zelavis/website"].name, "@zelavis/website");
  assert.equal(runtime.services["@zelavis/db"], undefined);
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("database.")),
  );
});

test("zelavis can disable the auth core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
    },
  });

  assert.equal(runtime.services["@zelavis/auth"], undefined);
  assert.equal(runtime.services["@zelavis/db"].name, "@zelavis/db");
  assert.equal(runtime.services["@zelavis/website"].name, "@zelavis/website");
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("auth.")),
  );
});

test("zelavis can disable the dashboard core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      dashboard: false,
    },
  });

  assert.equal(runtime.services["@zelavis/ui"], undefined);
  assert.equal(runtime.services["@zelavis/auth"].name, "@zelavis/auth");
  assert.equal(runtime.services["@zelavis/db"].name, "@zelavis/db");
  assert.equal(runtime.services["@zelavis/website"].name, "@zelavis/website");
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("dashboard.")),
  );
});

test("zelavis uses a configurable root path for dashboard and APIs", async () => {
  const runtime = await zelavis({
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
  assert.match(dashboardBody, /"basename":"\/admin"/);
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
    coreServices: {
      dashboard: {
        devServerUrl: "http://127.0.0.1:3001",
      },
    },
  });

  const settingsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/settings?tab=auth", {
      redirect: "manual",
    }),
  );
  assert.equal(settingsResponse.status, 307);
  assert.equal(
    settingsResponse.headers.get("location"),
    "http://127.0.0.1:3001/settings?tab=auth",
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
    coreServices: {
      dashboard: {
        devServerUrl: "http://127.0.0.1:3001/zelavis",
      },
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

test("zelavis can disable all core services", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      dashboard: false,
      database: false,
      website: false,
    },
  });

  assert.deepEqual(runtime.services, {});
  assert.equal(runtime.routes.length, 0);
});

test("zelavis does not duplicate an explicitly provided database service", async () => {
  const databaseService = {
    name: "@zelavis/db",
    service: { custom: true },
    api: {
      v1: [
        {
          id: "custom.database",
          method: "GET",
          path: "/custom",
          handler: () => ({ status: 204 }),
        },
      ],
    },
  };
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      dashboard: false,
      website: false,
    },
    runtimeServices: [databaseService],
  });

  assert.equal(runtime.services["@zelavis/db"].service.custom, true);
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].route.id, "custom.database");
});

test("zelavis does not duplicate an explicitly provided auth service", async () => {
  const authService = {
    name: "@zelavis/auth",
    service: { custom: true },
    api: {
      v1: [
        {
          id: "custom.auth",
          method: "GET",
          path: "/custom",
          handler: () => ({ status: 204 }),
        },
      ],
    },
  };
  const runtime = await zelavis({
    coreServices: {
      dashboard: false,
      database: false,
      website: false,
    },
    runtimeServices: [authService],
  });

  assert.equal(runtime.services["@zelavis/auth"].service.custom, true);
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].route.id, "custom.auth");
});

test("zelavis can provide public website pages as a core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      database: false,
      website: true,
    },
  });

  assert.equal(runtime.services["@zelavis/website"].name, "@zelavis/website");
  assert.equal(runtime.services["@zelavis/ui"].name, "@zelavis/ui");
  assert.ok(runtime.routes.some((route) => route.fullPath === "/*path"));
  assert.ok(runtime.routes.some((route) => route.fullPath === "/zelavis"));
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/runtime/config",
    ),
  );
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/website/pages",
    ),
  );

  const listPagesResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages"),
  );
  assert.equal(listPagesResponse.status, 200);
  const listedPagesPayload = await listPagesResponse.json();
  assert.equal(Array.isArray(listedPagesPayload.pages), true);

  const createPageResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Public company page.",
      }),
    }),
  );
  assert.equal(createPageResponse.status, 201);
  const createdPage = await createPageResponse.json();
  assert.equal(createdPage.path, "/about");
  assert.equal(createdPage.title, "About");

  const createHomeResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Zelavis",
        path: "/",
        headline: "Composable backend platform.",
        description: "Public pages can now be served by Zelavis.",
      }),
    }),
  );
  assert.equal(createHomeResponse.status, 201);

  const createDocsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Docs",
        path: "/docs",
        headline: "Docs placeholder",
        description: "Docs will be mounted here later.",
      }),
    }),
  );
  assert.equal(createDocsResponse.status, 201);

  const duplicateDocsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Docs Again",
        path: "/docs",
      }),
    }),
  );
  assert.equal(duplicateDocsResponse.status, 409);

  const homeResponse = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Composable backend platform/);

  const docsResponse = await runtime.fetch(
    new Request("http://localhost/docs"),
  );
  assert.equal(docsResponse.status, 200);
  assert.match(await docsResponse.text(), /Docs placeholder/);

  const aboutResponse = await runtime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 200);
  assert.match(await aboutResponse.text(), /About Zelavis/);

  const dashboardResponse = await runtime.fetch(
    new Request("http://localhost/zelavis"),
  );
  assert.equal(dashboardResponse.status, 200);
  assert.match(await dashboardResponse.text(), /Zelavis Dashboard/);
});

test("zelavis keeps public routes inactive until the home page exists", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      database: false,
      website: true,
    },
  });

  const createAboutResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Public company page.",
      }),
    }),
  );
  assert.equal(createAboutResponse.status, 201);

  const homeResponse = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(homeResponse.status, 307);
  assert.equal(homeResponse.headers.get("location"), "/zelavis");

  const aboutResponse = await runtime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 404);
});

test("zelavis persists dashboard settings and website pages through the database layer", async () => {
  const database = await createDatabase();

  const firstRuntime = await zelavis({
    coreServices: {
      auth: false,
      database,
      website: true,
    },
  });

  const initialHomeResponse = await firstRuntime.fetch(
    new Request("http://localhost/"),
  );
  assert.equal(initialHomeResponse.status, 307);
  assert.equal(initialHomeResponse.headers.get("location"), "/zelavis");

  const createPageResponse = await firstRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Persisted through the shared database layer.",
      }),
    }),
  );
  assert.equal(createPageResponse.status, 201);

  const aboutBeforeHomeResponse = await firstRuntime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutBeforeHomeResponse.status, 404);

  const createHomePageResponse = await firstRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Home",
        path: "/",
        headline: "Welcome to Zelavis",
        description: "Seeded through the shared database layer.",
      }),
    }),
  );
  assert.equal(createHomePageResponse.status, 201);

  const restartedRuntime = await zelavis({
    coreServices: {
      auth: false,
      database,
      website: true,
    },
  });

  const homeResponse = await restartedRuntime.fetch(
    new Request("http://localhost/"),
  );
  assert.equal(homeResponse.status, 200);
  assert.match(
    await homeResponse.text(),
    /Seeded through the shared database layer/,
  );

  const aboutResponse = await restartedRuntime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 200);
  assert.match(
    await aboutResponse.text(),
    /Persisted through the shared database layer/,
  );
});

test("zelavis rejects invalid persisted dashboard settings on read", async () => {
  const runtime = await zelavis({
    coreServices: {
      dashboard: {
        settingsStore: {
          async read() {
            return {
              theme: "violet",
            };
          },
          async write(update) {
            return update;
          },
        },
      },
    },
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/settings"),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Stored dashboard theme must be one of/);
});

test("zelavis rejects invalid persisted website pages on read", async () => {
  const database = await createDatabase();
  await database.documents.createCollection({ name: "zelavis_system" });
  await database.documents.insert({
    collection: "zelavis_system",
    id: "website.pages",
    data: {
      kind: "website-pages",
      pages: [
        {
          path: "/broken",
          title: "Broken",
          actions: [{ label: "Missing href" }],
        },
      ],
    },
  });

  const runtime = await zelavis({
    coreServices: {
      auth: false,
      database,
      website: true,
    },
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages"),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Stored website actions require a label and href/);
});
