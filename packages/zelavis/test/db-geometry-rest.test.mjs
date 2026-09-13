// Geometry: nearest-neighbour ordering, distance paging, lines, edge-to-edge intersections, DoS budget.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { MAX_GEOMETRY_VERTICES } from "../dist/db/spatial.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });
const BRANDENBURG = [13.3777, 52.5163];

// Berlin landmarks at different known distances from Brandenburg Gate:
// 1. Gate: 0m
// 2. Reichstag: ~400m north-west
// 3. Victory Column: ~1.9km west
// 4. Alexanderplatz TV Tower: ~2.2km east
const PLACES = [
  ["tower", point(13.4094, 52.5208), "tower"],
  ["gate", point(13.3777, 52.5163), "monument"],
  ["column", point(13.3501, 52.5145), "monument"],
  ["reichstag", point(13.3762, 52.5186), "government"],
];

const SPATIAL = { fields: ["where"], resolution: 9, version: 1 };

for (const [engine, open] of engines) {
  const setup = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-geo-rest-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "places", spatial: SPATIAL });
      for (const [id, where, kind] of PLACES) {
        yield* docs.insert({ collection: "places", id, data: { where, kind } });
      }
      return yield* body(docs, store);
    })));
  };

  test(`${engine}: nearest-neighbour ordering sorts closest-first and exposes distance`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const results = yield* docs.findMany({
        collection: "places",
        geometry: { field: "where", near: BRANDENBURG, radius: 3000 },
      });

      // All 4 are within 3000m.
      assert.equal(results.length, 4);

      // Verify distance is exposed on each document
      for (const doc of results) {
        assert.equal(typeof doc.distance, "number");
        assert.ok(doc.distance >= 0);
      }

      // Expected closest to farthest order:
      // gate (0m), reichstag (~300m), column (~1900m), tower (~2200m)
      const ids = results.map((d) => d.id);
      assert.deepEqual(ids, ["gate", "reichstag", "column", "tower"]);
      assert.equal(results[0].distance, 0);
      assert.ok(results[0].distance < results[1].distance);
      assert.ok(results[1].distance < results[2].distance);
      assert.ok(results[2].distance < results[3].distance);

      // Explicit descending sort by distance
      const reversed = yield* docs.findMany({
        collection: "places",
        geometry: { field: "where", near: BRANDENBURG, radius: 3000 },
        orderBy: [{ path: "$distance", direction: "desc" }],
      });
      assert.deepEqual(reversed.map((d) => d.id), ["tower", "column", "reichstag", "gate"]);
    })));

  test(`${engine}: findPage pages by distance cursor in nearest-neighbour order`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const filter = { field: "where", near: BRANDENBURG, radius: 3000 };

      // Page 1: limit 2
      const page1 = yield* docs.findPage({
        collection: "places",
        geometry: filter,
        limit: 2,
      });

      assert.equal(page1.documents.length, 2);
      assert.deepEqual(page1.documents.map((d) => d.id), ["gate", "reichstag"]);
      assert.ok(page1.next, "next cursor should be present");
      assert.ok(page1.documents[0].distance <= page1.documents[1].distance);

      // Page 2: next 2 items
      const page2 = yield* docs.findPage({
        collection: "places",
        geometry: filter,
        limit: 2,
        after: page1.next,
      });

      assert.equal(page2.documents.length, 2);
      assert.deepEqual(page2.documents.map((d) => d.id), ["column", "tower"]);
      assert.ok(page1.documents[1].distance <= page2.documents[0].distance);
      assert.ok(page2.documents[0].distance <= page2.documents[1].distance);

      // Combined
      const all = [...page1.documents, ...page2.documents];
      assert.deepEqual(all.map((d) => d.id), ["gate", "reichstag", "column", "tower"]);
    })));

  test(`${engine}: LineString geometries are indexed and queryable by near and intersects`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "routes",
        spatial: { fields: ["path"], resolution: 8, version: 1 },
      });

      // A line passing near Berlin, with endpoints far to the west and east:
      // Endpoint 1: [13.0, 52.51] (~26km west)
      // Endpoint 2: [13.8, 52.51] (~28km east)
      // Midpoint: [13.4, 52.51] (~1.7km from Brandenburg Gate)
      const spree = {
        type: "LineString",
        coordinates: [[13.0, 52.51], [13.8, 52.51]],
      };
      yield* docs.insert({ collection: "routes", id: "river-spree", data: { path: spree } });

      // Query with near: radius 2500m around Brandenburg gate
      // Neither endpoint is within 2500m, but the segment passes ~1.6km away
      const found = yield* docs.findMany({
        collection: "routes",
        geometry: { field: "path", near: BRANDENBURG, radius: 2500 },
      });
      assert.equal(found.length, 1);
      assert.equal(found[0].id, "river-spree");
      assert.ok(found[0].distance < 2500, `distance is within radius: ${found[0].distance}m`);

      // Query with intersects against a polygon cutting across the line
      const crossingPolygon = {
        type: "Polygon",
        coordinates: [[[13.37, 52.50], [13.39, 52.50], [13.39, 52.53], [13.37, 52.53], [13.37, 52.50]]],
      };
      const intersecting = yield* docs.findMany({
        collection: "routes",
        geometry: { field: "path", intersects: crossingPolygon },
      });
      assert.equal(intersecting.length, 1);
      assert.equal(intersecting[0].id, "river-spree");
    })));

  test(`${engine}: polygon-to-polygon intersection detects edge crossing without internal vertices`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "shapes",
        spatial: { fields: ["geom"], resolution: 6, version: 1 },
      });

      // Vertical strip
      const verticalStrip = {
        type: "Polygon",
        coordinates: [[[2, 0], [3, 0], [3, 10], [2, 10], [2, 0]]],
      };
      yield* docs.insert({ collection: "shapes", id: "vert", data: { geom: verticalStrip } });

      // Horizontal strip crossing the vertical strip in a plus sign
      const horizontalStrip = {
        type: "Polygon",
        coordinates: [[[0, 4], [10, 4], [10, 5], [0, 5], [0, 4]]],
      };

      const found = yield* docs.findMany({
        collection: "shapes",
        geometry: { field: "geom", intersects: horizontalStrip },
      });

      assert.equal(found.length, 1);
      assert.equal(found[0].id, "vert");
    })));

  test(`${engine}: DoS budget protects against pathologically large geometries`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const hugeCoords = [];
      for (let i = 0; i <= MAX_GEOMETRY_VERTICES + 10; i++) {
        hugeCoords.push([13.4 + i * 0.0001, 52.5]);
      }
      const hugeLine = {
        type: "LineString",
        coordinates: hugeCoords,
      };

      // Inserting a geometry exceeding budget fails with RangeError
      const exit = yield* Effect.exit(docs.insert({ collection: "places", id: "huge", data: { where: hugeLine } }));
      assert.ok(Exit.isFailure(exit), "should fail on excessive vertices");
    })));
}
