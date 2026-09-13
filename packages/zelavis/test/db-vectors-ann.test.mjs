// Vector slice two: approximate index (ANN / usearch) and findPage score pagination.
//
// Document bytes in the database remain authoritative; the ANN index is an
// in-memory projection that can be dropped and rebuilt from the stored documents
// at any time. findPage pages by similarity score descending (score DESC, seq ASC)
// with a cursor that survives concurrent writes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor, measureRecall, normalized } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

for (const [engine, open] of engines) {
  const setup = (t, body, { embedding = { field: "vec", dimension: 4, metric: "cosine", version: 1 } } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-ann-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({
        name: "items",
        embedding,
      });
      return yield* body(docs, store);
    })));
  };

  test(`${engine}: findPage pages by score descending with valid cursors`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Insert items with known directions from [1, 0, 0, 0]
      const items = [
        ["p1", [1, 0, 0, 0]],      // score = 1.0
        ["p2", [0.9, 0.1, 0, 0]],  // score ~ 0.99
        ["p3", [0.7, 0.7, 0, 0]],  // score ~ 0.7
        ["p4", [0.5, 0.8, 0, 0]],  // score ~ 0.5
        ["p5", [0, 1, 0, 0]],      // score = 0.0
      ];
      for (const [id, vec] of items) {
        yield* docs.insert({ collection: "items", id, data: { vec } });
      }

      // Page 1: limit 2
      const page1 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
        cursors: true,
      });

      assert.equal(page1.documents.length, 2);
      assert.equal(page1.documents[0].id, "p1");
      assert.equal(page1.documents[1].id, "p2");
      assert.ok(page1.documents[0].score >= page1.documents[1].score);
      assert.ok(page1.next !== undefined, "page1 must have next cursor");
      assert.equal(page1.cursors?.length, 2);

      // Page 2: limit 2, after page1.next
      const page2 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
        after: page1.next,
      });

      assert.equal(page2.documents.length, 2);
      assert.equal(page2.documents[0].id, "p3");
      assert.equal(page2.documents[1].id, "p4");
      assert.ok(page2.documents[0].score >= page2.documents[1].score);
      assert.ok(page2.next !== undefined, "page2 must have next cursor");

      // Page 3: limit 2, after page2.next
      const page3 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
        after: page2.next,
      });

      assert.equal(page3.documents.length, 1);
      assert.equal(page3.documents[0].id, "p5");
      assert.equal(page3.next, undefined, "page3 is the last page");
    })));

  test(`${engine}: score cursor survives concurrent writes without duplicate or skipped items`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const items = [
        ["a", [1, 0, 0, 0]],      // score 1.0
        ["b", [0.8, 0.2, 0, 0]],  // score ~ 0.97
        ["c", [0.6, 0.4, 0, 0]],  // score ~ 0.83
        ["d", [0.4, 0.6, 0, 0]],  // score ~ 0.55
      ];
      for (const [id, vec] of items) {
        yield* docs.insert({ collection: "items", id, data: { vec } });
      }

      // Read page 1
      const page1 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
      });
      assert.deepEqual(page1.documents.map((d) => d.id), ["a", "b"]);

      // Concurrent writes:
      // 1. A new item with higher score than page 1's last item ("b") -> should not disrupt page 2
      yield* docs.insert({ collection: "items", id: "higher", data: { vec: [0.95, 0.05, 0, 0] } });
      // 2. A new item with score between "b" and "c" -> should appear on page 2
      yield* docs.insert({ collection: "items", id: "between", data: { vec: [0.7, 0.3, 0, 0] } });
      // 3. A new item with lower score -> should appear later
      yield* docs.insert({ collection: "items", id: "lower", data: { vec: [0.1, 0.9, 0, 0] } });

      // Read page 2 using page1.next
      const page2 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
        after: page1.next,
      });

      // Page 2 should see "between" then "c" (since "between" scores higher than "c" but lower than "b")
      assert.deepEqual(page2.documents.map((d) => d.id), ["between", "c"]);

      // Page 3 using page2.next
      const page3 = yield* docs.findPage({
        collection: "items",
        similar: { field: "vec", vector: [1, 0, 0, 0] },
        limit: 2,
        after: page2.next,
      });
      assert.deepEqual(page3.documents.map((d) => d.id), ["d", "lower"]);
    })));

  test(`${engine}: vector projection index can be rebuilt, dropped, and maintained`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.insert({ collection: "items", id: "doc1", data: { vec: [1, 0, 0, 0] } });
      yield* docs.insert({ collection: "items", id: "doc2", data: { vec: [0, 1, 0, 0] } });
      yield* docs.insert({ collection: "items", id: "doc3", data: { vec: [0, 0, 1, 0] } });

      // Build projection index
      const rebuild1 = yield* docs.rebuildVectorIndex({ collection: "items" });
      assert.equal(rebuild1.indexed, 3);

      const idx1 = yield* docs.getVectorIndex({ collection: "items" });
      assert.ok(idx1 !== undefined);
      assert.equal(idx1.size(), 3);

      // Writes update projection index
      yield* docs.insert({ collection: "items", id: "doc4", data: { vec: [0, 0, 0, 1] } });
      assert.equal(idx1.size(), 4);

      // Deletes update projection index
      yield* docs.delete({ collection: "items", id: "doc4" });
      assert.equal(idx1.size(), 3);

      // Drop projection index
      const dropped = yield* docs.dropVectorIndex({ collection: "items" });
      assert.equal(dropped, true);
      const idxAfterDrop = yield* docs.getVectorIndex({ collection: "items" });
      assert.equal(idxAfterDrop, undefined);

      // Rebuilding works again from stored documents
      const rebuild2 = yield* docs.rebuildVectorIndex({ collection: "items" });
      assert.equal(rebuild2.indexed, 3);
      const idx2 = yield* docs.getVectorIndex({ collection: "items" });
      assert.equal(idx2?.size(), 3);
    })));

  test(`${engine}: recall@k measurement against exact ground truth (>= 0.95 for f32/f16)`, (t) =>
    setup(
      t,
      (docs) => Effect.gen(function* () {
        const DIM = 8;
        const COUNT = 60;
        const K = 10;

        // Pseudo-random deterministic vectors
        let seed = 42;
        const rand = () => {
          seed = (seed * 16807) % 2147483647;
          return (seed - 1) / 2147483646;
        };

        for (let i = 0; i < COUNT; i++) {
          const raw = [];
          for (let d = 0; d < DIM; d++) raw.push(rand() * 2 - 1);
          const vec = normalized(raw);
          yield* docs.insert({ collection: "items", id: `item-${i}`, data: { vec } });
        }

        // Build ANN projection
        yield* docs.rebuildVectorIndex({ collection: "items" });

        const queryRaw = [];
        for (let d = 0; d < DIM; d++) queryRaw.push(rand() * 2 - 1);
        const queryVec = normalized(queryRaw);

        // Exact search (ground truth)
        const groundTruthDocs = yield* docs.findMany({
          collection: "items",
          similar: { field: "vec", vector: queryVec, k: K, approximate: false },
        });
        const groundTruthIds = groundTruthDocs.map((d) => d.id);

        // Approximate search
        const approxDocs = yield* docs.findMany({
          collection: "items",
          similar: { field: "vec", vector: queryVec, k: K, approximate: true },
        });
        const approxIds = approxDocs.map((d) => d.id);

        const recall = measureRecall(groundTruthIds, approxIds);
        assert.ok(
          recall >= 0.95,
          `Expected recall@${K} >= 0.95, got ${recall} (exact: ${groundTruthIds}, approx: ${approxIds})`,
        );
      }),
      { embedding: { field: "vec", dimension: 8, metric: "cosine", quantization: "f32", version: 1 } },
    ));

  test(`${engine}: quantized storage (f16, i8, b1) supports ANN projection`, (t) =>
    setup(
      t,
      (docs) => Effect.gen(function* () {
        const DIM = 8;
        const COUNT = 30;

        let seed = 1234;
        const rand = () => {
          seed = (seed * 16807) % 2147483647;
          return (seed - 1) / 2147483646;
        };

        for (let i = 0; i < COUNT; i++) {
          const raw = [];
          for (let d = 0; d < DIM; d++) raw.push(rand() * 2 - 1);
          yield* docs.insert({ collection: "items", id: `q-${i}`, data: { vec: normalized(raw) } });
        }

        for (const q of ["f16", "i8", "b1"]) {
          yield* docs.embed({
            collection: "items",
            embedding: { field: "vec", dimension: DIM, metric: "cosine", quantization: q, version: 2 },
          });
          const rebuilt = yield* docs.rebuildVectorIndex({ collection: "items" });
          assert.equal(rebuilt.indexed, COUNT);

          const queryRaw = [];
          for (let d = 0; d < DIM; d++) queryRaw.push(rand() * 2 - 1);
          const results = yield* docs.findMany({
            collection: "items",
            similar: { field: "vec", vector: normalized(queryRaw), k: 5, approximate: true },
          });
          assert.equal(results.length, 5, `Quantization ${q} should return 5 results`);
        }
      }),
      { embedding: { field: "vec", dimension: 8, metric: "cosine", quantization: "f32", version: 1 } },
    ));
}
