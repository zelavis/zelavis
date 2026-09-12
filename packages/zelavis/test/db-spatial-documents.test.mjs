// Geometry on documents: cells narrow, the exact check decides.
//
// The point of every test here is the gap between those two. A cell covers
// ground its geometry does not, so a candidate is not an answer — and the one
// test that matters most is the neighbour sharing a cell with the centre while
// lying outside the radius.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { distanceBetween } from "../dist/db/spatial.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });
const BRANDENBURG = [13.3777, 52.5163];

// Berlin landmarks, and one in Paris.
const PLACES = [
  ["gate", point(13.3777, 52.5163), "monument"],
  ["column", point(13.3501, 52.5145), "monument"],   // ~1.9 km west
  ["tower", point(13.4094, 52.5208), "tower"],       // ~2.2 km east
  ["eiffel", point(2.2945, 48.8584), "tower"],       // another country
];

const SPATIAL = { fields: ["where"], resolution: 9, version: 1 };

for (const [engine, open] of engines) {
  const setup = (t, body, { spatial = SPATIAL } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-geo-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "places", ...(spatial === undefined ? {} : { spatial }) });
      for (const [id, where, kind] of PLACES) {
        yield* docs.insert({ collection: "places", id, data: { where, kind } });
      }
      return yield* body(docs, store);
    })));
  };
  const ids = (found) => found.map((d) => d.id).sort();
  const find = (docs, input) => Effect.map(docs.findMany({ collection: "places", ...input }), ids);
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);

  test(`${engine}: a radius is metres, not whichever cells happened to match`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // The column is about 1.9 km away. A 1 km radius must exclude it even
      // though a coarse covering will offer it as a candidate.
      const near = (radius) => find(docs, { geometry: { field: "where", near: BRANDENBURG, radius } });
      assert.ok(distanceBetween(BRANDENBURG, [13.3501, 52.5145]) > 1000, "the column really is beyond a kilometre");

      assert.deepEqual(yield* near(100), ["gate"], "only the gate itself");
      assert.deepEqual(yield* near(2500), ["column", "gate", "tower"], "all three in Berlin");
      assert.deepEqual(yield* near(5_000_000), ["column", "eiffel", "gate", "tower"], "and Paris, at continental scale");

      // A search is one more set: it narrows with ordinary filters.
      assert.deepEqual(
        yield* find(docs, {
          geometry: { field: "where", near: BRANDENBURG, radius: 2500 },
          where: [{ path: "kind", value: "tower" }],
        }),
        ["tower"],
      );
    })));

  test(`${engine}: a box and a shape decide on coordinates too`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const berlinBox = { west: 13.3, south: 52.45, east: 13.45, north: 52.56 };
      assert.deepEqual(
        yield* find(docs, { geometry: { field: "where", within: berlinBox } }),
        ["column", "gate", "tower"],
      );

      // A polygon around the gate alone, with the column outside it.
      const aroundTheGate = {
        type: "Polygon",
        coordinates: [[[13.37, 52.51], [13.39, 52.51], [13.39, 52.52], [13.37, 52.52], [13.37, 52.51]]],
      };
      assert.deepEqual(
        yield* find(docs, { geometry: { field: "where", intersects: aroundTheGate } }),
        ["gate"],
      );

      // A box across the antimeridian holds nothing here, and says so rather
      // than wrapping the wrong way round the globe.
      assert.deepEqual(
        yield* find(docs, { geometry: { field: "where", within: { west: 170, south: -10, east: -170, north: 10 } } }),
        [],
      );
    })));

  test(`${engine}: a page carries the filter, and an unindexed field is said`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const filter = { field: "where", near: BRANDENBURG, radius: 2500 };
      const page = yield* docs.findPage({ collection: "places", geometry: filter, limit: 2 });
      assert.equal(page.documents.length, 2);
      assert.ok(page.next);
      const rest = yield* docs.findPage({ collection: "places", geometry: filter, limit: 2, after: page.next });
      assert.deepEqual(
        [...page.documents, ...rest.documents].map((d) => d.id).sort(),
        ["column", "gate", "tower"],
      );

      assert.equal(
        yield* tagOf(docs.findMany({ collection: "places", geometry: { field: "elsewhere", near: BRANDENBURG, radius: 10 } })),
        "UnindexedGeometry",
      );
    })));

  test(`${engine}: writes, sealing and a resolution change keep the answers`, (t) =>
    setup(t, (docs, store) => Effect.gen(function* () {
      const near = () => find(docs, { geometry: { field: "where", near: BRANDENBURG, radius: 2500 } });
      const before = yield* near();

      yield* store.sealPostings;
      assert.deepEqual(yield* near(), before, "sealing folds the cells and changes nothing");

      // Moving a document moves its cells with it.
      yield* docs.update({ collection: "places", id: "tower", data: { where: point(2.2950, 48.8590) } });
      assert.deepEqual(yield* near(), ["column", "gate"], "it left Berlin");
      yield* docs.delete({ collection: "places", id: "column" });
      assert.deepEqual(yield* near(), ["gate"], "and a delete takes its cells too");

      // A coarser index is a different covering, so every document is rewritten.
      const relocated = yield* docs.locate({
        collection: "places", spatial: { fields: ["where"], resolution: 6, version: 2 },
      });
      // The column was deleted above, so the rewrite has one fewer to write.
      assert.equal(relocated.documents, PLACES.length - 1);
      assert.deepEqual(yield* near(), ["gate"], "and the answers do not move with the resolution");

      assert.equal(yield* tagOf(docs.locate({
        collection: "places", spatial: { fields: ["where"], resolution: 99, version: 3 },
      })), "InvalidConstraint");
    })));
}
