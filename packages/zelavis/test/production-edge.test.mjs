import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createMemorySystemStore, createZelavisEdgeManager, createZelavisEdgeRouteStore, createTraefikEdgeAdapter, createTraefikCertificateDistributor, compileTraefikPublication } from "../dist/index.js";
import { ensureProductionEdge } from "../dist/edge/production.js";
import { platform } from "./_runtime.mjs";

function fixture() {
  const store = createMemorySystemStore(), routes = createZelavisEdgeRouteStore({ store });
  const events = [];
  let running = false;
  const invoker = { execute: async (id, args) => {
    events.push({ id, args });
    if (id === "zelavis.edge-unit-control") {
      if (args.action === "start") running = true;
      return { active: running, status: running ? "active" : "inactive" };
    }
    if (id === "zelavis.edge-validate") return { valid: true };
    if (id === "zelavis.edge-activate") return { status: "activated" };
    return {};
  } };
  const adapter = createTraefikEdgeAdapter({ invoker, routeStore: routes, drainDurationMs: 0 });
  const manager = createZelavisEdgeManager({ store, adapters: [adapter], certificates: createTraefikCertificateDistributor({ invoker }), defaultAdapterId: "traefik" });
  return { store, routes, manager, events, stop: () => { running = false; } };
}

test("production ingress publishes an HTTP fallback, preserves domain routes and recovers without restarting Traefik", async () => {
  const f = fixture(), timestamp = new Date().toISOString();
  await f.routes.putHostname({ host: "example.com", scope: "platform", tlsMode: "external", createdAt: timestamp, updatedAt: timestamp });
  await f.routes.putRoute({ id: "platform:domain", scope: "platform", hostname: "example.com", pathPrefix: "/", pathMatch: "prefix",
    priority: 1, targets: [{ url: "http://127.0.0.1:3100", weight: 100 }], protocols: ["http"], createdAt: timestamp, updatedAt: timestamp });
  const ensure = () => Effect.runPromise(ensureProductionEdge({ ...f, port: 3200 }));
  await ensure();
  const publication = await f.routes.getCurrentPublication();
  assert.equal(publication.routes.length, 2);
  assert.equal(publication.routes.find(route => route.id === "platform:default").targets[0].url, "http://127.0.0.1:3200");
  const { configuration } = compileTraefikPublication(publication);
  const routers = Object.values(configuration.http.routers);
  const fallback = routers.find(router => router.rule === "PathPrefix(`/`)");
  assert.deepEqual(fallback.entryPoints, ["web"]);
  assert.equal(fallback.tls, undefined);
  for (const router of routers.filter(router => router.rule.includes("Host("))) assert.ok(router.priority > fallback.priority);
  const events = f.events.length;
  await ensure();
  assert.equal((await f.routes.getCurrentPublication()).revision, publication.revision);
  assert.ok(!f.events.slice(events).some(event => event.id === "zelavis.edge-stage"));
  f.stop(); await ensure();
  assert.ok(f.events.some(event => event.id === "zelavis.edge-unit-control" && event.args.action === "start"));
  assert.ok(!f.events.some(event => ["stop", "reload", "restart"].includes(event.args.action)));
});

test("hostname-independent routing is reserved for the Platform fallback and cannot target ingress itself", async () => {
  const f = fixture(), timestamp = new Date().toISOString();
  await assert.rejects(f.routes.putRoute({ id: "project:one", scope: "project", projectId: "one", hostname: "*", pathPrefix: "/", pathMatch: "prefix",
    priority: 1, targets: [{ url: "http://127.0.0.1:3200", weight: 100 }], protocols: ["http"], createdAt: timestamp, updatedAt: timestamp }), /reserved/);
  for (const port of [80, 443, NaN]) await assert.rejects(Effect.runPromise(ensureProductionEdge({ ...f, port })), /distinct from production ingress/);
  assert.equal((await f.routes.listRoutes()).length, 0);
});

test("named and bulk renewal refresh only the active Edge publication", async t => {
  const f = fixture(), timestamp = new Date().toISOString();
  const certificateRef = "certificate:example.com";
  const sanHostnames = ["www.example.com"];
  let bulkRenewed = [];
  const runtime = await platform(t, {
    systemStore: f.store,
    edge: f.manager,
    edgeRoutes: f.routes,
    edgeCertificates: {
      getCertificate: async ref => {
        assert.equal(ref, certificateRef);
        return { sanHostnames };
      },
      orderCertificate: async input => {
        assert.deepEqual(input.sanHostnames, sanHostnames);
        assert.equal(input.forceRenew, true);
        return { ref: certificateRef };
      },
      checkRenewals: async () => ({ checked: 1, renewed: bulkRenewed, failed: [] }),
    },
  });
  await f.routes.putHostname({ host: "example.com", scope: "platform", tlsMode: "managed", certificateRef,
    createdAt: timestamp, updatedAt: timestamp });
  await Effect.runPromise(ensureProductionEdge({ ...f, port: 3200 }));
  const active = await f.routes.getCurrentPublication();
  const afterInitial = f.events.length;
  const renew = input => runtime.send("POST", "/runtime/edge/certificates/renew", input);
  await renew({});
  bulkRenewed = ["certificate:unpublished.example.com"];
  await renew({});
  assert.equal(f.events.length, afterInitial);

  await f.routes.putRoute({ id: "platform:pending", scope: "platform", hostname: "pending.example.com", pathPrefix: "/", pathMatch: "prefix",
    priority: 1, targets: [{ url: "http://127.0.0.1:3100", weight: 100 }], protocols: ["http"], createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual((await renew({ hostname: "example.com" })).renewed, [certificateRef]);
  const stage = f.events.slice(afterInitial).find(event => event.id === "zelavis.edge-stage");
  assert.ok(stage);
  assert.equal(stage.args.generation, String(active.revision));
  assert.ok(!stage.args["config-json"].includes("pending.example.com"));

  const beforeBulk = f.events.length;
  bulkRenewed = [certificateRef];
  assert.deepEqual((await renew({})).renewed, [certificateRef]);
  assert.ok(f.events.slice(beforeBulk).some(event => event.id === "zelavis.edge-activate"));

  await f.routes.compile();
  const beforeConflict = f.events.length;
  await assert.rejects(renew({}), { status: 409, message: /newer Edge publication is pending/ });
  assert.equal(f.events.length, beforeConflict);
  assert.equal((await f.manager.getPolicy()).activePublication.revision, String(active.revision));
});
