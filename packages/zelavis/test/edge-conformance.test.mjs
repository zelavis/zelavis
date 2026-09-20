import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemorySystemStore,
  createZelavisEdgeManager,
  createZelavisEdgeRouteStore,
  toPublicationSummary,
  ZelavisEdgeSwitchError,
  ZelavisEdgeValidationError,
} from "../dist/index.js";
import {
  compileCaddyPublication,
  createCaddyEdgeAdapter,
} from "./fixtures/caddy-adapter.mjs";

function makeTraefikAdapter(events, overrides = {}) {
  let active = false;
  return {
    id: "traefik",
    title: "Traefik",
    capabilities: [
      "http",
      "https",
      "websocket",
      "sse",
      "weighted-targets",
      "active-health-checks",
      "connection-draining",
      "certificate-hot-reload",
    ],
    async detect() {
      events.push("traefik:detect");
      return {
        state: "available",
        installed: true,
        healthy: true,
        checkedAt: new Date().toISOString(),
        version: "3.7.13",
      };
    },
    async stage(context) {
      events.push(`traefik:stage:${context.switchId}`);
    },
    async verify(context) {
      events.push(`traefik:verify:${context.switchId}`);
      return { ready: true };
    },
    async activate(context) {
      events.push(`traefik:activate:${context.switchId}`);
      active = true;
    },
    async drain(context) {
      events.push(`traefik:drain:${context.switchId}`);
      active = false;
    },
    async rollback(context) {
      events.push(`traefik:rollback:${context.switchId}`);
      active = false;
    },
    isActive() {
      return active;
    },
    ...overrides,
  };
}

function makeCertificateDistributor(events) {
  return {
    async stage(context) {
      events.push(`certificates:stage:${context.switchId}`);
    },
    async activate(context) {
      events.push(`certificates:activate:${context.switchId}`);
    },
    async rollback(context) {
      events.push(`certificates:rollback:${context.switchId}`);
    },
  };
}

async function setupPopulatedPlatform(store) {
  const edgeRoutes = createZelavisEdgeRouteStore({ store });

  // 1. Setup sample Projects in System Store
  await store.set("system.projects", "prj_alpha", {
    id: "prj_alpha",
    name: "Alpha Web Application",
    recipe: { name: "zelavis-app", version: "0.1.0" },
    state: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  await store.set("system.projects", "prj_beta", {
    id: "prj_beta",
    name: "Beta API Service",
    recipe: { name: "generic", version: "1.0.0" },
    state: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
  });

  // 2. Setup multiple canonical hostnames across scopes and TLS modes
  await edgeRoutes.putHostname({
    host: "panel.example.com",
    scope: "platform",
    tlsMode: "managed",
    certificateRef: "cert:panel.example.com",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putHostname({
    host: "app.example.com",
    scope: "project",
    projectId: "prj_alpha",
    tlsMode: "managed",
    certificateRef: "cert:app.example.com",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putHostname({
    host: "api.partner.org",
    scope: "project",
    projectId: "prj_beta",
    tlsMode: "external",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putHostname({
    host: "dev.local",
    scope: "project",
    projectId: "prj_alpha",
    tlsMode: "none",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });

  // 3. Setup multiple canonical routes: platform, weighted targets, websockets, health checks
  await edgeRoutes.putRoute({
    id: "platform:dashboard",
    scope: "platform",
    hostname: "panel.example.com",
    pathPrefix: "/zelavis",
    pathMatch: "exact",
    priority: 10,
    protocols: ["http"],
    targets: [{ url: "http://127.0.0.1:4000", weight: 100 }],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putRoute({
    id: "platform:api",
    scope: "platform",
    hostname: "panel.example.com",
    pathPrefix: "/api",
    pathMatch: "prefix",
    priority: 5,
    protocols: ["http"],
    targets: [{ url: "http://127.0.0.1:4000", weight: 100 }],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putRoute({
    id: "project:prj_alpha:web",
    scope: "project",
    projectId: "prj_alpha",
    hostname: "app.example.com",
    pathPrefix: "/",
    pathMatch: "prefix",
    priority: 1,
    protocols: ["http"],
    targets: [
      { url: "http://127.0.0.1:5001", weight: 80, placementGeneration: 1 },
      { url: "http://127.0.0.1:5002", weight: 20, placementGeneration: 1 },
    ],
    healthCheck: {
      path: "/healthz",
      intervalMs: 5000,
      timeoutMs: 2000,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  await edgeRoutes.putRoute({
    id: "project:prj_alpha:ws",
    scope: "project",
    projectId: "prj_alpha",
    hostname: "app.example.com",
    pathPrefix: "/ws",
    pathMatch: "prefix",
    priority: 20,
    protocols: ["websocket"],
    targets: [{ url: "http://127.0.0.1:5001", weight: 100 }],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });

  const compiled = await edgeRoutes.compile();
  return {
    edgeRoutes,
    compiled,
    publicationSummary: toPublicationSummary(compiled),
  };
}

test("Alternate-adapter conformance: pure Caddy compiler produces valid native JSON structure", async () => {
  const store = createMemorySystemStore();
  const { compiled } = await setupPopulatedPlatform(store);

  const { config } = compileCaddyPublication(compiled);

  assert.ok(config.apps.http.servers.zelavis);
  const server = config.apps.http.servers.zelavis;
  assert.deepEqual(server.listen, [":443", ":80"]);

  // SNI policies match managed and external hostnames
  assert.deepEqual(server.tls_connection_policies[0].match.sni.sort(), [
    "api.partner.org",
    "app.example.com",
    "panel.example.com",
  ]);

  // Routes compiled
  assert.equal(server.routes.length, 4);

  // Exact match router for /zelavis
  const dashboardRoute = server.routes.find((r) => r.match[0].path?.[0] === "/zelavis");
  assert.ok(dashboardRoute);
  assert.deepEqual(dashboardRoute.match[0].host, ["panel.example.com"]);
  assert.equal(dashboardRoute.handle[0].upstreams[0].dial, "127.0.0.1:4000");

  // Weighted route with health checks
  const appRoute = server.routes.find((r) => r.match[0].host[0] === "app.example.com" && !r.match[0].path);
  assert.ok(appRoute);
  assert.equal(appRoute.handle[0].upstreams.length, 2);
  assert.equal(appRoute.handle[0].upstreams[0].dial, "127.0.0.1:5001");
  assert.equal(appRoute.handle[0].upstreams[0].weight, 80);
  assert.equal(appRoute.handle[0].upstreams[1].dial, "127.0.0.1:5002");
  assert.equal(appRoute.handle[0].upstreams[1].weight, 20);
  assert.equal(appRoute.handle[0].health_checks.active.path, "/healthz");
});

test("Alternate-adapter conformance: Traefik -> Caddy -> Traefik roundtrip preserves 100% of canonical state", async () => {
  const store = createMemorySystemStore();
  const { edgeRoutes, publicationSummary } = await setupPopulatedPlatform(store);

  // Take snapshot of canonical routes, hostnames, and projects
  const initialHostnames = await edgeRoutes.listHostnames();
  const initialRoutes = await edgeRoutes.listRoutes();
  const initialAlphaProject = await store.get("system.projects", "prj_alpha");
  const initialBetaProject = await store.get("system.projects", "prj_beta");

  const events = [];
  const traefik = makeTraefikAdapter(events);
  const caddy = createCaddyEdgeAdapter({ events });
  const certificates = makeCertificateDistributor(events);

  let switchCount = 0;
  const manager = createZelavisEdgeManager({
    store,
    adapters: [traefik, caddy],
    defaultAdapterId: "traefik",
    certificates,
    createSwitchId: () => `switch-${++switchCount}`,
  });

  // Step 1: Start on Traefik
  const first = await manager.switchAdapter("traefik", publicationSummary);
  assert.equal(first.phase, "complete");
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  // Step 2: Switch to Caddy
  events.length = 0;
  const toCaddy = await manager.switchAdapter("caddy", publicationSummary);
  assert.equal(toCaddy.phase, "complete");
  assert.equal((await manager.getPolicy()).activeAdapterId, "caddy");

  // Verify full lifecycle order: detect -> stage-certs -> stage-routing -> verify -> activate-certs -> activate-routing -> drain -> commit
  assert.deepEqual(events, [
    "caddy:detect",
    "certificates:stage:switch-2",
    "caddy:stage:switch-2",
    "caddy:verify:switch-2",
    "certificates:activate:switch-2",
    "caddy:activate:switch-2",
    "traefik:drain:switch-2",
  ]);

  // INVARIANCE ASSERTION 1: Canonical hostnames untouched
  const hostnamesAfterCaddy = await edgeRoutes.listHostnames();
  assert.deepEqual(hostnamesAfterCaddy, initialHostnames);

  // INVARIANCE ASSERTION 2: Canonical routes untouched
  const routesAfterCaddy = await edgeRoutes.listRoutes();
  assert.deepEqual(routesAfterCaddy, initialRoutes);

  // INVARIANCE ASSERTION 3: Certificate references untouched
  const certRefsAfterCaddy = hostnamesAfterCaddy.map((h) => h.certificateRef).filter(Boolean);
  const initialCertRefs = initialHostnames.map((h) => h.certificateRef).filter(Boolean);
  assert.deepEqual(certRefsAfterCaddy, initialCertRefs);

  // INVARIANCE ASSERTION 4: Project records in store untouched
  assert.deepEqual(await store.get("system.projects", "prj_alpha"), initialAlphaProject);
  assert.deepEqual(await store.get("system.projects", "prj_beta"), initialBetaProject);

  // Step 3: Switch back from Caddy to Traefik
  events.length = 0;
  const backToTraefik = await manager.switchAdapter("traefik", publicationSummary);
  assert.equal(backToTraefik.phase, "complete");
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  assert.deepEqual(events, [
    "traefik:detect",
    "certificates:stage:switch-3",
    "traefik:stage:switch-3",
    "traefik:verify:switch-3",
    "certificates:activate:switch-3",
    "traefik:activate:switch-3",
    "caddy:drain:switch-3",
  ]);

  // INVARIANCE ASSERTION 5: Canonical state still 100% intact after roundtrip
  assert.deepEqual(await edgeRoutes.listHostnames(), initialHostnames);
  assert.deepEqual(await edgeRoutes.listRoutes(), initialRoutes);
  assert.deepEqual(await store.get("system.projects", "prj_alpha"), initialAlphaProject);
  assert.deepEqual(await store.get("system.projects", "prj_beta"), initialBetaProject);
});

test("Alternate-adapter conformance: verification failure triggers clean rollback without mutating state", async () => {
  const store = createMemorySystemStore();
  const { edgeRoutes, publicationSummary } = await setupPopulatedPlatform(store);

  const initialHostnames = await edgeRoutes.listHostnames();
  const initialRoutes = await edgeRoutes.listRoutes();
  const initialAlphaProject = await store.get("system.projects", "prj_alpha");

  const events = [];
  const traefik = makeTraefikAdapter(events);
  const brokenCaddy = createCaddyEdgeAdapter({
    events,
    failVerification: "Upstream synthetic health check probe timed out",
  });
  const certificates = makeCertificateDistributor(events);

  let switchCount = 0;
  const manager = createZelavisEdgeManager({
    store,
    adapters: [traefik, brokenCaddy],
    defaultAdapterId: "traefik",
    certificates,
    createSwitchId: () => `switch-rollback-${++switchCount}`,
  });

  // Start on Traefik
  await manager.switchAdapter("traefik", publicationSummary);
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  // Attempt switch to broken Caddy
  events.length = 0;
  await assert.rejects(
    manager.switchAdapter("caddy", publicationSummary),
    (error) => {
      assert.ok(error instanceof ZelavisEdgeSwitchError);
      assert.ok(error.cause instanceof ZelavisEdgeValidationError);
      assert.match(error.cause.message, /Upstream synthetic health check probe timed out/);
      assert.equal(error.record.phase, "failed");
      return true;
    },
  );

  // Verify rollback execution sequence:
  // Staged, verified, then immediately rolled back without activating or draining Traefik!
  assert.deepEqual(events, [
    "caddy:detect",
    "certificates:stage:switch-rollback-2",
    "caddy:stage:switch-rollback-2",
    "caddy:verify:switch-rollback-2",
    "caddy:rollback:switch-rollback-2",
    "certificates:rollback:switch-rollback-2",
  ]);

  // Policy active adapter is STILL Traefik!
  const policy = await manager.getPolicy();
  assert.equal(policy.activeAdapterId, "traefik");

  // Invariance check: canonical routes, hostnames, and projects remain untouched
  assert.deepEqual(await edgeRoutes.listHostnames(), initialHostnames);
  assert.deepEqual(await edgeRoutes.listRoutes(), initialRoutes);
  assert.deepEqual(await store.get("system.projects", "prj_alpha"), initialAlphaProject);
});

test("Alternate-adapter conformance: capability shortfall is rejected during preflight before staging", async () => {
  const store = createMemorySystemStore();
  const { edgeRoutes, publicationSummary } = await setupPopulatedPlatform(store);

  const initialHostnames = await edgeRoutes.listHostnames();
  const initialRoutes = await edgeRoutes.listRoutes();

  const events = [];
  const traefik = makeTraefikAdapter(events);
  // Limited adapter lacking websocket capability
  const limitedAdapter = {
    ...createCaddyEdgeAdapter({ events }),
    id: "limited-proxy",
    title: "Limited Proxy",
    capabilities: [
      "http",
      "https",
      "sse",
      "weighted-targets",
      "active-health-checks",
      "connection-draining",
      "certificate-hot-reload",
    ], // Specifically missing "websocket" which publication requires
  };
  const certificates = makeCertificateDistributor(events);

  const manager = createZelavisEdgeManager({
    store,
    adapters: [traefik, limitedAdapter],
    defaultAdapterId: "traefik",
    certificates,
    createSwitchId: () => "switch-limited",
  });

  // Start on Traefik
  await manager.switchAdapter("traefik", publicationSummary);
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  events.length = 0;
  // Plan shows missing capability
  const plan = await manager.planSwitch("limited-proxy", publicationSummary);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missingCapabilities, ["websocket"]);

  // Attempt switch to limited proxy
  await assert.rejects(
    manager.switchAdapter("limited-proxy", publicationSummary),
    (error) => {
      assert.ok(error instanceof ZelavisEdgeSwitchError);
      assert.ok(error.cause instanceof ZelavisEdgeValidationError);
      assert.match(error.cause.message, /missing capabilities: websocket/);
      return true;
    },
  );

  // Verify limited adapter was NEVER staged: only detect and cleanup
  assert.ok(!events.some((e) => e.includes("limited-proxy:stage")));
  assert.ok(!events.some((e) => e.includes("traefik:drain")));

  // Active adapter remains Traefik
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  // Canonical state is completely unchanged
  assert.deepEqual(await edgeRoutes.listHostnames(), initialHostnames);
  assert.deepEqual(await edgeRoutes.listRoutes(), initialRoutes);
});
