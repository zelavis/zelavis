// Every operation the database offers has a route.
//
// This exists because the hand check kept failing. Search and geometry were
// wired when they landed; embeddings, typed edges, measures, `linked` and
// `similar` were not, and the aggregates had no route at all -- three slices in
// a row. Wiring a capability is a separate step from building one, and nothing
// failed when it was skipped, so it kept being skipped.
//
// Coverage is derived rather than listed. A hand-maintained map of method to
// route would rot exactly the way the thing it is meant to catch rots, so the
// tenant API is wrapped in a recorder and every route is invoked: a handler
// that reaches for `documents.summarize` touches it even if the call then
// fails, which is all this needs to know.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { openTemporaryDatabase } from "./_database.mjs";

/**
 * The dashboard's principal. Naming a Tenant is an operator act, so a route
 * invoked with one needs inspect authority to get as far as the call being
 * recorded here.
 */
const operator = {
  id: "operator",
  type: "user",
  permissions: ["database.inspect", "database.read", "database.write"],
};

/** Every route the service mounts, its nested services included. */
const routesOf = (service) => [
  ...service.api.v1,
  ...service.services.flatMap((nested) => nested.api.v1),
];

/**
 * The database, with every `documents` property access recorded.
 *
 * Only the reach matters, so each method answers with a rejection: a handler
 * calling one is asking the question this test is about, and what comes back
 * is the route's business rather than ours.
 */
const recording = (api, touched) => ({
  ...api,
  forTenant: (tenantId) => {
    const tenant = api.forTenant(tenantId);
    return {
      ...tenant,
      documents: new Proxy(tenant.documents, {
        get(target, property) {
          if (typeof property === "string") touched.add(property);
          const held = Reflect.get(target, property);
          if (typeof held !== "function") return held;
          return () => Promise.reject(new TypeError("reached"));
        },
      }),
    };
  },
});

test("every documents operation is reachable through a route", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const touched = new Set();
  const service = defineDatabaseService(recording(api, touched));

  for (const route of routesOf(service)) {
    try {
      await Promise.resolve(route.handler({
        service: recording(api, touched),
        params: { collection: "items", id: "x", name: "n", series: "s", view: "v" },
        query: new URLSearchParams({ tenantId: "acme" }),
        // An operator, because these cases name the Tenant they address.
        principal: operator,
        // Enough of a body that a handler reaches its call rather than
        // stopping at a missing tenant; the call itself is expected to fail.
        body: {
          tenantId: "acme",
          name: "items",
          measure: "m",
          op: "sum",
          groupBy: "g",
          documents: [],
          operations: [],
          analyzer: { fields: ["title"], version: 1 },
          spatial: { fields: ["where"], resolution: 9, version: 1 },
          embedding: { field: "vec", dimension: 3, metric: "cosine", version: 1 },
          where: [],
          fields: [{ path: "a" }],
          path: "a",
          collection: "items",
          data: {},
        },
        headers: {},
        request: undefined,
      }));
    } catch {
      // The call is expected to fail; only the reach is being recorded.
    }
  }

  // The surface a caller can reach in process, which is what a route must cover.
  const surface = Object.keys(api.forTenant("acme").documents);
  const unreachable = surface.filter((method) => !touched.has(method));

  assert.deepEqual(
    unreachable,
    [],
    `these documents operations have no route: ${unreachable.join(", ")}. ` +
      "Add one, or this capability exists only in process.",
  );
  // Guard the guard: if the recorder stopped recording, the assertion above
  // would pass by touching nothing.
  assert.ok(touched.size >= surface.length, "the recorder saw the routes reach the API");
});

test("every timeSeries operation is reachable through a route", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const touched = new Set();
  const recordingTs = (baseApi) => ({
    ...baseApi,
    forTenant: (tenantId) => {
      const tenant = baseApi.forTenant(tenantId);
      return {
        ...tenant,
        timeSeries: new Proxy(tenant.timeSeries, {
          get(target, property) {
            if (typeof property === "string") touched.add(property);
            const held = Reflect.get(target, property);
            if (typeof held !== "function") return held;
            return () => Promise.reject(new TypeError("reached"));
          },
        }),
      };
    },
  });

  const service = defineDatabaseService(recordingTs(api));

  for (const route of routesOf(service)) {
    try {
      await Promise.resolve(route.handler({
        service: recordingTs(api),
        params: { collection: "items", id: "x", name: "n", series: "s", view: "v" },
        query: new URLSearchParams({ tenantId: "acme" }),
        // An operator, because these cases name the Tenant they address.
        principal: operator,
        body: {
          tenantId: "acme",
          interval: 1000,
          step: 1000,
          window: { count: 1 },
          op: "sum",
        },
        headers: {},
        request: undefined,
      }));
    } catch {
      // The call is expected to fail; only the reach is being recorded.
    }
  }

  const surface = Object.keys(api.forTenant("acme").timeSeries);
  const unreachable = surface.filter((method) => !touched.has(method));

  assert.deepEqual(
    unreachable,
    [],
    `these timeSeries operations have no route: ${unreachable.join(", ")}. ` +
      "Add one, or this capability exists only in process.",
  );
  assert.ok(touched.size >= surface.length, "the recorder saw the routes reach the timeSeries API");
});
