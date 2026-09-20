import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemorySystemStore,
  createZelavisEdgeRouteStore,
  createZelavisEdgeManager,
  preflightHostname,
  performEdgeOnboarding,
  zelavis,
} from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

test("preflightHostname: validates syntax and attempts DNS lookup", async () => {
  // Invalid hostnames
  const invalid1 = await preflightHostname("not a domain");
  assert.equal(invalid1.valid, false);

  const invalid2 = await preflightHostname("-invalid.com");
  assert.equal(invalid2.valid, false);

  const invalid3 = await preflightHostname("");
  assert.equal(invalid3.valid, false);

  // Valid hostname syntax
  const valid = await preflightHostname("panel.example.com");
  assert.equal(valid.valid, true);
  assert.equal(valid.hostname, "panel.example.com");
});

test("performEdgeOnboarding: handles later mode without creating routes", async () => {
  const store = createMemorySystemStore();
  const routeStore = createZelavisEdgeRouteStore({ store });

  const result = await performEdgeOnboarding(
    { routeStore },
    { mode: "later" },
  );

  assert.equal(result.mode, "later");
  assert.equal(result.status, "deferred");

  const routes = await routeStore.listRoutes();
  assert.equal(routes.length, 0);
  const hostnames = await routeStore.listHostnames();
  assert.equal(hostnames.length, 0);
});

test("performEdgeOnboarding: configures external TLS hostname and platform route", async () => {
  const store = createMemorySystemStore();
  const routeStore = createZelavisEdgeRouteStore({ store });

  const result = await performEdgeOnboarding(
    { routeStore },
    { mode: "external", hostname: "panel.example.com", localTargetUrl: "http://127.0.0.1:4000" },
  );

  assert.equal(result.mode, "external");
  assert.equal(result.status, "configured");
  assert.equal(result.hostname, "panel.example.com");
  assert.equal(result.canonicalUrl, "https://panel.example.com");
  assert.ok(result.publication);

  // Check stored hostname
  const hostname = await routeStore.getHostname("panel.example.com");
  assert.ok(hostname);
  assert.equal(hostname.scope, "platform");
  assert.equal(hostname.tlsMode, "external");

  // Check stored route
  const route = await routeStore.getRoute("platform:root");
  assert.ok(route);
  assert.equal(route.scope, "platform");
  assert.equal(route.hostname, "panel.example.com");
  assert.equal(route.pathPrefix, "/");
  assert.deepEqual(route.targets, [{ url: "http://127.0.0.1:4000", weight: 100 }]);
});

test("performEdgeOnboarding: configures managed TLS and triggers edge switch", async () => {
  const store = createMemorySystemStore();
  const routeStore = createZelavisEdgeRouteStore({ store });

  let switchedAdapterId;
  let switchedPub;
  const mockEdgeManager = {
    async switchAdapter(adapterId, pub) {
      switchedAdapterId = adapterId;
      switchedPub = pub;
      return { id: "switch-1", phase: "complete" };
    },
  };

  const result = await performEdgeOnboarding(
    { routeStore, edgeManager: mockEdgeManager },
    { mode: "managed", hostname: "app.example.com" },
  );

  assert.equal(result.mode, "managed");
  assert.equal(result.status, "configured");
  assert.equal(result.hostname, "app.example.com");
  assert.equal(switchedAdapterId, "traefik");
  assert.ok(switchedPub);

  const hostname = await routeStore.getHostname("app.example.com");
  assert.ok(hostname);
  assert.equal(hostname.tlsMode, "managed");
  assert.equal(hostname.certificateRef, "certificate:app.example.com");
});

test("Edge Onboarding HTTP & SDK parity", async (t) => {
  const store = createMemorySystemStore();
  const runtime = await zelavis({
    systemStore: store,
    resolvePrincipal: () => ({ id: "owner", type: "user", permissions: ["*"] }),
  });
  t.after(() => runtime.close());

  const client = createZelavisClient({
    baseUrl: "http://localhost",
    rootPath: "/zelavis",
    fetch: (input, init) => runtime.fetch(new Request(input, init)),
  });

  // 1. Preflight check
  const preflight = await client.edge.preflightHostname("my-panel.example.com");
  assert.equal(preflight.valid, true);
  assert.equal(preflight.hostname, "my-panel.example.com");

  // 2. Onboard via SDK
  const onboardResult = await client.edge.onboardHostname({
    mode: "external",
    hostname: "my-panel.example.com",
  });
  assert.equal(onboardResult.status, "configured");
  assert.equal(onboardResult.canonicalUrl, "https://my-panel.example.com");

  // 3. Verify routes list via SDK
  const routesResp = await client.edge.routes();
  assert.equal(routesResp.routes.length, 1);
  assert.equal(routesResp.routes[0].id, "platform:root");
  assert.equal(routesResp.hostnames.length, 1);
  assert.equal(routesResp.hostnames[0].host, "my-panel.example.com");
});
