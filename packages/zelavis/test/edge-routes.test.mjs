import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemorySystemStore,
  createZelavisEdgeRouteStore,
  deriveEdgeCapabilities,
  toPublicationSummary,
  zelavis,
  ZelavisEdgeValidationError,
} from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";

function makeHostname(overrides = {}) {
  return {
    host: "app.example.com",
    scope: "project",
    projectId: "my-app",
    tlsMode: "managed",
    certificateRef: "certificate:app.example.com",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeRoute(overrides = {}) {
  return {
    id: "project:my-app:app.example.com",
    scope: "project",
    projectId: "my-app",
    hostname: "app.example.com",
    pathPrefix: "/",
    pathMatch: "prefix",
    targets: [{ url: "http://127.0.0.1:54321", weight: 100 }],
    protocols: ["http"],
    priority: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function createStore() {
  const systemStore = createMemorySystemStore();
  return createZelavisEdgeRouteStore({ store: systemStore });
}

// ---------------------------------------------------------------------------
// Hostname CRUD
// ---------------------------------------------------------------------------

test("putHostname creates a new hostname", async () => {
  const store = createStore();
  const hostname = await store.putHostname(makeHostname());
  assert.equal(hostname.host, "app.example.com");
  assert.equal(hostname.scope, "project");
  assert.equal(hostname.tlsMode, "managed");
  assert.equal(hostname.certificateRef, "certificate:app.example.com");
});

test("putHostname updates an existing hostname", async () => {
  const store = createStore();
  await store.putHostname(makeHostname());
  const updated = await store.putHostname(
    makeHostname({ tlsMode: "external", certificateRef: undefined }),
  );
  assert.equal(updated.tlsMode, "external");
  assert.equal(updated.certificateRef, undefined);
});

test("getHostname returns stored hostname", async () => {
  const store = createStore();
  await store.putHostname(makeHostname());
  const hostname = await store.getHostname("app.example.com");
  assert.equal(hostname?.host, "app.example.com");
});

test("getHostname returns undefined for unknown host", async () => {
  const store = createStore();
  const hostname = await store.getHostname("unknown.example.com");
  assert.equal(hostname, undefined);
});

test("deleteHostname removes a hostname", async () => {
  const store = createStore();
  await store.putHostname(makeHostname());
  const deleted = await store.deleteHostname("app.example.com");
  assert.equal(deleted, true);
  const hostname = await store.getHostname("app.example.com");
  assert.equal(hostname, undefined);
});

test("listHostnames returns all hostnames sorted by key", async () => {
  const store = createStore();
  await store.putHostname(makeHostname({ host: "b.example.com" }));
  await store.putHostname(makeHostname({ host: "a.example.com" }));
  const hostnames = await store.listHostnames();
  assert.equal(hostnames.length, 2);
  assert.equal(hostnames[0].host, "a.example.com");
  assert.equal(hostnames[1].host, "b.example.com");
});

test("listHostnames filters by scope", async () => {
  const store = createStore();
  await store.putHostname(
    makeHostname({ host: "platform.example.com", scope: "platform", projectId: undefined }),
  );
  await store.putHostname(makeHostname({ host: "app.example.com" }));
  const platformOnly = await store.listHostnames({ scope: "platform" });
  assert.equal(platformOnly.length, 1);
  assert.equal(platformOnly[0].host, "platform.example.com");
});

test("listHostnames filters by projectId", async () => {
  const store = createStore();
  await store.putHostname(makeHostname({ host: "a.example.com", projectId: "proj-1" }));
  await store.putHostname(makeHostname({ host: "b.example.com", projectId: "proj-2" }));
  const proj1 = await store.listHostnames({ projectId: "proj-1" });
  assert.equal(proj1.length, 1);
  assert.equal(proj1[0].host, "a.example.com");
});

// ---------------------------------------------------------------------------
// Hostname validation
// ---------------------------------------------------------------------------

test("hostname validation rejects invalid FQDNs", async () => {
  const store = createStore();
  await assert.rejects(
    store.putHostname(makeHostname({ host: "not a hostname!" })),
    ZelavisEdgeValidationError,
  );
});

test("hostname validation normalizes uppercase to lowercase", async () => {
  const store = createStore();
  const hostname = await store.putHostname(
    makeHostname({ host: "APP.EXAMPLE.COM" }),
  );
  assert.equal(hostname.host, "app.example.com");
});

test("hostname validation strips trailing dots", async () => {
  const store = createStore();
  const hostname = await store.putHostname(
    makeHostname({ host: "app.example.com." }),
  );
  assert.equal(hostname.host, "app.example.com");
});

test("hostname validation rejects managed TLS without certificateRef", async () => {
  const store = createStore();
  await assert.rejects(
    store.putHostname(
      makeHostname({ tlsMode: "managed", certificateRef: undefined }),
    ),
    ZelavisEdgeValidationError,
  );
});

test("hostname validation rejects none TLS with certificateRef", async () => {
  const store = createStore();
  await assert.rejects(
    store.putHostname(
      makeHostname({ tlsMode: "none", certificateRef: "cert:orphan" }),
    ),
    ZelavisEdgeValidationError,
  );
});

test("hostname validation rejects project scope without projectId", async () => {
  const store = createStore();
  await assert.rejects(
    store.putHostname(makeHostname({ scope: "project", projectId: undefined })),
    ZelavisEdgeValidationError,
  );
});

// ---------------------------------------------------------------------------
// Route CRUD
// ---------------------------------------------------------------------------

test("putRoute creates a new route", async () => {
  const store = createStore();
  const route = await store.putRoute(makeRoute());
  assert.equal(route.id, "project:my-app:app.example.com");
  assert.equal(route.hostname, "app.example.com");
  assert.equal(route.targets.length, 1);
});

test("putRoute updates an existing route", async () => {
  const store = createStore();
  await store.putRoute(makeRoute());
  const updated = await store.putRoute(
    makeRoute({ priority: 10 }),
  );
  assert.equal(updated.priority, 10);
});

test("getRoute returns stored route", async () => {
  const store = createStore();
  await store.putRoute(makeRoute());
  const route = await store.getRoute("project:my-app:app.example.com");
  assert.equal(route?.id, "project:my-app:app.example.com");
});

test("getRoute returns undefined for unknown id", async () => {
  const store = createStore();
  const route = await store.getRoute("nonexistent");
  assert.equal(route, undefined);
});

test("deleteRoute removes a route", async () => {
  const store = createStore();
  await store.putRoute(makeRoute());
  const deleted = await store.deleteRoute("project:my-app:app.example.com");
  assert.equal(deleted, true);
  assert.equal(await store.getRoute("project:my-app:app.example.com"), undefined);
});

test("listRoutes sorts by priority descending then id ascending", async () => {
  const store = createStore();
  await store.putRoute(makeRoute({ id: "route:b", priority: 5 }));
  await store.putRoute(makeRoute({ id: "route:a", priority: 10 }));
  await store.putRoute(makeRoute({ id: "route:c", priority: 5 }));
  const routes = await store.listRoutes();
  assert.deepEqual(
    routes.map((r) => r.id),
    ["route:a", "route:b", "route:c"],
  );
});

test("listRoutes filters by scope, projectId, and hostname", async () => {
  const store = createStore();
  await store.putRoute(
    makeRoute({
      id: "platform:dashboard",
      scope: "platform",
      projectId: undefined,
      hostname: "panel.example.com",
    }),
  );
  await store.putRoute(makeRoute({ id: "project:my-app:app.example.com" }));
  assert.equal(
    (await store.listRoutes({ scope: "platform" })).length,
    1,
  );
  assert.equal(
    (await store.listRoutes({ projectId: "my-app" })).length,
    1,
  );
  assert.equal(
    (await store.listRoutes({ hostname: "panel.example.com" })).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

test("route validation rejects missing targets", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(makeRoute({ targets: [] })),
    ZelavisEdgeValidationError,
  );
});

test("route validation rejects invalid target weight", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(
      makeRoute({
        targets: [{ url: "http://127.0.0.1:3000", weight: 0 }],
      }),
    ),
    ZelavisEdgeValidationError,
  );
  await assert.rejects(
    store.putRoute(
      makeRoute({
        targets: [{ url: "http://127.0.0.1:3000", weight: 101 }],
      }),
    ),
    ZelavisEdgeValidationError,
  );
});

test("route validation rejects invalid target URL", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(
      makeRoute({
        targets: [{ url: "ftp://wrong-protocol", weight: 50 }],
      }),
    ),
    ZelavisEdgeValidationError,
  );
});

test("route validation rejects pathPrefix without leading slash", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(makeRoute({ pathPrefix: "no-slash" })),
    ZelavisEdgeValidationError,
  );
});

test("route validation rejects unknown protocols", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(makeRoute({ protocols: ["ftp"] })),
    ZelavisEdgeValidationError,
  );
});

test("route validation rejects project scope without projectId", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(makeRoute({ scope: "project", projectId: undefined })),
    ZelavisEdgeValidationError,
  );
});

// ---------------------------------------------------------------------------
// Project route cleanup
// ---------------------------------------------------------------------------

test("deleteProjectRoutes removes all scoped routes and hostnames", async () => {
  const store = createStore();
  await store.putHostname(makeHostname({ host: "a.example.com", projectId: "proj-1" }));
  await store.putHostname(makeHostname({ host: "b.example.com", projectId: "proj-2" }));
  await store.putRoute(makeRoute({ id: "route:a", projectId: "proj-1" }));
  await store.putRoute(makeRoute({ id: "route:b", projectId: "proj-2" }));

  const deleted = await store.deleteProjectRoutes("proj-1");
  assert.equal(deleted, 2); // 1 route + 1 hostname
  assert.equal(await store.getRoute("route:a"), undefined);
  assert.equal(await store.getHostname("a.example.com"), undefined);
  // proj-2 resources survive.
  assert.ok(await store.getRoute("route:b"));
  assert.ok(await store.getHostname("b.example.com"));
});

// ---------------------------------------------------------------------------
// Publication compilation
// ---------------------------------------------------------------------------

test("compile produces an immutable publication with correct capabilities", async () => {
  const store = createStore();
  await store.putHostname(
    makeHostname({ host: "app.example.com", tlsMode: "managed", certificateRef: "cert:app" }),
  );
  await store.putRoute(
    makeRoute({
      id: "route:app",
      hostname: "app.example.com",
      protocols: ["http", "websocket"],
      targets: [
        { url: "http://127.0.0.1:3000", weight: 80 },
        { url: "http://127.0.0.1:3001", weight: 20 },
      ],
    }),
  );
  await store.putRoute(
    makeRoute({
      id: "route:api",
      hostname: "app.example.com",
      pathPrefix: "/api",
      protocols: ["http"],
      healthCheck: {
        path: "/health",
        intervalMs: 10000,
        timeoutMs: 5000,
        unhealthyThreshold: 3,
        healthyThreshold: 1,
      },
    }),
  );

  const publication = await store.compile();
  assert.equal(publication.schemaVersion, 1);
  assert.equal(publication.revision, 1);
  assert.equal(publication.routeCount, 2);
  assert.equal(publication.hostnames.length, 1);
  assert.equal(publication.routes.length, 2);
  assert.deepEqual(publication.certificateRefs, ["cert:app"]);
  // Capabilities: http (routes), https + certificate-hot-reload (managed TLS),
  // websocket (protocol), weighted-targets (varying weights), active-health-checks (healthCheck)
  assert.ok(publication.requiredCapabilities.includes("http"));
  assert.ok(publication.requiredCapabilities.includes("https"));
  assert.ok(publication.requiredCapabilities.includes("certificate-hot-reload"));
  assert.ok(publication.requiredCapabilities.includes("websocket"));
  assert.ok(publication.requiredCapabilities.includes("weighted-targets"));
  assert.ok(publication.requiredCapabilities.includes("active-health-checks"));
});

test("empty compilation produces a valid zero-route publication", async () => {
  const store = createStore();
  const publication = await store.compile();
  assert.equal(publication.revision, 1);
  assert.equal(publication.routeCount, 0);
  assert.equal(publication.hostnames.length, 0);
  assert.equal(publication.routes.length, 0);
  assert.deepEqual(publication.requiredCapabilities, []);
  assert.deepEqual(publication.certificateRefs, []);
});

test("successive compilations advance revision monotonically", async () => {
  const store = createStore();
  const first = await store.compile();
  const second = await store.compile();
  const third = await store.compile();
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(third.revision, 3);
});

test("getCurrentPublication returns the latest compiled publication", async () => {
  const store = createStore();
  assert.equal(await store.getCurrentPublication(), undefined);
  await store.compile();
  await store.putRoute(makeRoute());
  const second = await store.compile();
  const current = await store.getCurrentPublication();
  assert.equal(current?.revision, second.revision);
  assert.equal(current?.routeCount, 1);
});

test("getPublication retrieves a specific revision", async () => {
  const store = createStore();
  const first = await store.compile();
  await store.putRoute(makeRoute());
  await store.compile();
  const retrieved = await store.getPublication(1);
  assert.equal(retrieved?.revision, first.revision);
  assert.equal(retrieved?.routeCount, 0); // First compilation had no routes.
});

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

test("deriveEdgeCapabilities produces correct capabilities", () => {
  const hostnames = [
    makeHostname({ tlsMode: "managed", certificateRef: "cert:a" }),
    makeHostname({ host: "plain.example.com", tlsMode: "none", certificateRef: undefined }),
  ];
  const routes = [
    makeRoute({
      protocols: ["http", "websocket", "sse"],
      targets: [
        { url: "http://127.0.0.1:3000", weight: 60 },
        { url: "http://127.0.0.1:3001", weight: 40 },
      ],
      healthCheck: {
        path: "/health",
        intervalMs: 5000,
        timeoutMs: 2000,
        unhealthyThreshold: 3,
        healthyThreshold: 1,
      },
    }),
  ];
  const capabilities = deriveEdgeCapabilities(routes, hostnames);
  assert.deepEqual(capabilities, [
    "active-health-checks",
    "certificate-hot-reload",
    "http",
    "https",
    "sse",
    "websocket",
    "weighted-targets",
  ]);
});

test("deriveEdgeCapabilities returns empty for no routes or hostnames", () => {
  assert.deepEqual(deriveEdgeCapabilities([], []), []);
});

// ---------------------------------------------------------------------------
// Publication summary bridge
// ---------------------------------------------------------------------------

test("toPublicationSummary extracts correct fields", async () => {
  const store = createStore();
  await store.putHostname(makeHostname());
  await store.putRoute(
    makeRoute({ protocols: ["http", "websocket"] }),
  );
  const compiled = await store.compile();
  const summary = toPublicationSummary(compiled);

  assert.equal(summary.id, "zelavis-edge-routes");
  assert.equal(summary.revision, String(compiled.revision));
  assert.equal(summary.routeCount, compiled.routeCount);
  assert.deepEqual(summary.requiredCapabilities, compiled.requiredCapabilities);
  assert.deepEqual(summary.certificateRefs, compiled.certificateRefs);
});

// ---------------------------------------------------------------------------
// Health check validation
// ---------------------------------------------------------------------------

test("health check validation rejects non-positive thresholds", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(
      makeRoute({
        healthCheck: {
          path: "/health",
          intervalMs: 0,
          timeoutMs: 5000,
          unhealthyThreshold: 3,
          healthyThreshold: 1,
        },
      }),
    ),
    ZelavisEdgeValidationError,
  );
});

test("health check validation rejects empty path", async () => {
  const store = createStore();
  await assert.rejects(
    store.putRoute(
      makeRoute({
        healthCheck: {
          path: "",
          intervalMs: 5000,
          timeoutMs: 2000,
          unhealthyThreshold: 3,
          healthyThreshold: 1,
        },
      }),
    ),
    ZelavisEdgeValidationError,
  );
});

// ---------------------------------------------------------------------------
// HTTP and SDK parity
// ---------------------------------------------------------------------------

test("SDK edge route methods work over HTTP", async (t) => {
  const systemStore = createMemorySystemStore();
  const runtime = await zelavis({
    systemStore,
    resolvePrincipal: () => ({ id: "owner", type: "user", permissions: ["*"] }),
  });
  t.after(() => runtime.close());

  const client = createZelavisClient({
    baseUrl: "http://localhost",
    rootPath: "/zelavis",
    fetch: (input, init) => runtime.fetch(new Request(input, init)),
  });

  // 1. List routes (initially empty)
  const initial = await client.edge.routes();
  assert.equal(initial.routes.length, 0);
  assert.equal(initial.hostnames.length, 0);
  assert.equal(initial.publication, undefined);

  // 2. Put route + hostname
  const created = await client.edge.putRoute({
    route: makeRoute({ id: "platform:dash", scope: "platform", projectId: undefined, hostname: "dash.example.com" }),
    hostname: makeHostname({ host: "dash.example.com", scope: "platform", projectId: undefined }),
  });
  assert.equal(created.route.id, "platform:dash");
  assert.equal(created.hostname?.host, "dash.example.com");

  // 3. List routes after put
  const afterPut = await client.edge.routes();
  assert.equal(afterPut.routes.length, 1);
  assert.equal(afterPut.hostnames.length, 1);

  // 4. Publish
  const publication = await client.edge.publish();
  assert.equal(publication.revision, 1);
  assert.equal(publication.routeCount, 1);
  assert.ok(publication.requiredCapabilities.includes("http"));

  // 5. Delete route
  const deleted = await client.edge.deleteRoute("platform:dash");
  assert.equal(deleted, true);

  // 6. Delete again returns false (404)
  const deleteAgain = await client.edge.deleteRoute("platform:dash");
  assert.equal(deleteAgain, false);
});

test("CLI edge routes and publish commands work end-to-end", async (t) => {
  const systemStore = createMemorySystemStore();
  const runtime = await zelavis({
    systemStore,
    resolvePrincipal: () => ({ id: "owner", type: "user", permissions: ["*"] }),
  });
  t.after(() => runtime.close());

  const fetcher = (url, init) => runtime.fetch(new Request(url, init));
  async function cli(args) {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const out = [];
    globalThis.fetch = fetcher;
    console.log = (value) => out.push(value);
    try {
      await runCli(["edge", ...args, "--url", "http://localhost/zelavis", "--json"]);
      return out.length ? JSON.parse(out.join("\n")) : undefined;
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  }

  // 1. Initially empty
  const initial = await cli(["routes", "list"]);
  assert.equal(initial.routes.length, 0);
  assert.equal(initial.hostnames.length, 0);

  // 2. Put route via CLI
  const created = await cli([
    "routes",
    "put",
    "project:test:app.example.com",
    "--hostname",
    "app.example.com",
    "--target",
    "http://127.0.0.1:8080",
    "--weight",
    "100",
    "--tls",
    "managed",
    "--certificate-ref",
    "cert:cli",
    "--project-id",
    "test",
  ]);
  assert.equal(created.route.id, "project:test:app.example.com");
  assert.equal(created.hostname?.tlsMode, "managed");

  // 3. Publish via CLI
  const published = await cli(["publish"]);
  assert.equal(published.revision, 1);
  assert.equal(published.routeCount, 1);
  assert.ok(published.requiredCapabilities.includes("https"));

  // 4. Delete via CLI
  const deleted = await cli(["routes", "delete", "project:test:app.example.com"]);
  assert.equal(deleted.deleted, true);

  // 5. List after delete
  const afterDelete = await cli(["routes", "list"]);
  assert.equal(afterDelete.routes.length, 0);
});
