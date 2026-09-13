// Typed links, as a lens rather than a field.
//
// A reference holds one id, so following it is a lookup. An edge holds a list,
// so following it is a posting scan -- and the postings are the neighbours' own
// identifiers, which is the whole point: `where` on the target collection
// narrows the neighbours before they are read. Most of these tests are about
// that intersection, and about the rewrite path, which re-derives edges through
// different code from the one that writes them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const EDGES = [{ name: "cites", path: "cites", collection: "papers" }];

// Four papers, listed in the order they can be written: a link must name a
// document that already exists, so the cited come before the citing.
// `first` cites three of them; `second` cites one; `third` and `fourth` none.
const PAPERS = [
  ["fourth", [], "chemistry", 2023],
  ["third", [], "physics", 2022],
  ["second", ["third"], "chemistry", 2021],
  ["first", ["second", "third", "fourth"], "physics", 2020],
];

for (const [engine, open] of engines) {
  const setup = (t, body, { edges = EDGES, papers = PAPERS } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-edge-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "papers", ...(edges === undefined ? {} : { edges }) });
      // In the order given, which is leaves-first; see `PAPERS`.
      for (const [id, cites, field, year] of papers) {
        yield* docs.insert({ collection: "papers", id, data: { cites, field, year } });
      }
      return yield* body(docs, store);
    })));
  };
  const ids = (found) => found.map((d) => d.id).sort();
  const find = (docs, input) => Effect.map(docs.findMany({ collection: "papers", ...input }), ids);
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
  const from = (id, edge = "cites") => ({ collection: "papers", id, edge });

  test(`${engine}: an edge holds many, and following it answers with all of them`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* find(docs, { linked: from("first") }), ["fourth", "second", "third"]);
      assert.deepEqual(yield* find(docs, { linked: from("second") }), ["third"]);
      // A document that links to nothing links to nothing; not an error.
      assert.deepEqual(yield* find(docs, { linked: from("third") }), []);
      // Nor is following the links of a document that is not there.
      assert.deepEqual(yield* find(docs, { linked: from("absent") }), []);
    })));

  test(`${engine}: the neighbours are narrowed before they are read`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // This is the reason the edge is a lens: the filter applies to the
      // neighbours, not to the document doing the linking.
      assert.deepEqual(
        yield* find(docs, { linked: from("first"), where: [{ path: "field", value: "physics" }] }),
        ["third"],
      );
      assert.deepEqual(
        yield* find(docs, { linked: from("first"), where: [{ path: "field", value: "chemistry" }] }),
        ["fourth", "second"],
      );
      assert.deepEqual(
        yield* find(docs, { linked: from("first"), where: [{ path: "year", op: "gte", value: 2022 }] }),
        ["fourth", "third"],
      );
    })));

  test(`${engine}: neighbours page, because a link is an intersection and not an order`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const first = yield* docs.findPage({ collection: "papers", linked: from("first"), limit: 2 });
      assert.equal(first.documents.length, 2);
      assert.ok(first.next !== undefined, "another neighbour follows");
      const second = yield* docs.findPage({
        collection: "papers", linked: from("first"), limit: 2, after: first.next,
      });
      assert.deepEqual(
        [...first.documents, ...second.documents].map((d) => d.id).sort(),
        ["fourth", "second", "third"],
        "the pages together are exactly the neighbours",
      );
      assert.equal(second.next, undefined, "and the last page says so");
    })));

  test(`${engine}: a rewrite re-derives the links rather than dropping them`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // analyze rewrites every document, through different code from the one
      // that wrote them. If that path forgot edges, adjacency would vanish
      // here and nowhere else.
      const rewritten = yield* docs.analyze({
        collection: "papers",
        analyzer: { fields: ["field"], version: 1 },
      });
      assert.equal(rewritten.documents, PAPERS.length);
      assert.deepEqual(yield* find(docs, { linked: from("first") }), ["fourth", "second", "third"]);
      // And the rewrite's own postings work alongside the re-derived ones.
      assert.deepEqual(
        yield* find(docs, { linked: from("first"), search: "chemistry" }),
        ["fourth", "second"],
      );
    })));

  test(`${engine}: a link to a document that is not there is refused`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(docs.insert({
          collection: "papers", id: "ghost", data: { cites: ["nobody"], field: "physics", year: 2024 },
        })),
        "ReferenceViolation",
      );
      assert.equal(
        yield* tagOf(docs.insert({
          collection: "papers", id: "wrong", data: { cites: [7], field: "physics", year: 2024 },
        })),
        "ReferenceViolation",
        "an id that is not a string",
      );
    })));

  test(`${engine}: a document may link to itself, and to one written beside it`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.insert({
        collection: "papers", id: "selfcite", data: { cites: ["selfcite"], field: "physics", year: 2024 },
      });
      assert.deepEqual(yield* find(docs, { linked: from("selfcite") }), ["selfcite"]);

      // Written in one batch, cited before citing: neither document existed
      // before the write, so the link only resolves if the overlay counts.
      yield* docs.write({
        operations: [
          { _tag: "Insert", collection: "papers", id: "beta", data: { cites: [], field: "physics", year: 2025 } },
          { _tag: "Insert", collection: "papers", id: "alpha", data: { cites: ["beta"], field: "physics", year: 2025 } },
        ],
      });
      assert.deepEqual(yield* find(docs, { linked: from("alpha") }), ["beta"]);

      // A cycle in one batch is refused, and says which link it could not
      // resolve. Links resolve as each change is applied, so the first of a
      // mutually citing pair names a document that exists nowhere yet.
      assert.equal(
        yield* tagOf(docs.write({
          operations: [
            { _tag: "Insert", collection: "papers", id: "one", data: { cites: ["two"], field: "physics", year: 2025 } },
            { _tag: "Insert", collection: "papers", id: "two", data: { cites: ["one"], field: "physics", year: 2025 } },
          ],
        })),
        "ReferenceViolation",
      );
    })));

  test(`${engine}: a single id is a short list, not a different thing`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* find(docs, { linked: from("only") }), ["third"]);
    }), {
      papers: [
        ["third", [], "physics", 2022],
        ["only", "third", "physics", 2024],
      ],
    }));

  test(`${engine}: an edge the collection does not declare says so`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(find(docs, { linked: from("first", "quotes") })),
        "UnknownEdge",
      );
      assert.equal(
        yield* tagOf(docs.findPage({ collection: "papers", linked: from("first", "quotes") })),
        "UnknownEdge",
        "and the paging read refuses it the same way",
      );
    })));

  test(`${engine}: a bad edge declaration is refused`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      for (const bad of [
        [{ name: "", path: "cites", collection: "papers" }],
        [{ name: "cites", path: "", collection: "papers" }],
        [{ name: "cites", path: "cites", collection: "" }],
        [
          { name: "cites", path: "cites", collection: "papers" },
          { name: "cites", path: "other", collection: "papers" },
        ],
      ]) {
        assert.equal(
          yield* tagOf(docs.createCollection({ name: "bad", edges: bad })),
          "InvalidConstraint",
          `${JSON.stringify(bad)} should not be declarable`,
        );
      }
    })));

  test(`${engine}: inbound adjacency: following an edge in reverse answers with all citing documents`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // "third" is cited by both "first" and "second"
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" } }),
        ["first", "second"],
      );
      // "second" is cited only by "first"
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "second", edge: "cites", direction: "inbound" } }),
        ["first"],
      );
      // "fourth" is cited only by "first"
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "fourth", edge: "cites", direction: "inbound" } }),
        ["first"],
      );
      // "first" is cited by nobody
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "first", edge: "cites", direction: "inbound" } }),
        [],
      );
      // An absent document has no incoming citations; not an error
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "absent", edge: "cites", direction: "inbound" } }),
        [],
      );
    })));

  test(`${engine}: inbound adjacency: neighbours are narrowed before read with where filter`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // "first" has field "physics", "second" has field "chemistry"
      assert.deepEqual(
        yield* find(docs, {
          linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" },
          where: [{ path: "field", value: "physics" }],
        }),
        ["first"],
      );
      assert.deepEqual(
        yield* find(docs, {
          linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" },
          where: [{ path: "field", value: "chemistry" }],
        }),
        ["second"],
      );
      assert.deepEqual(
        yield* find(docs, {
          linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" },
          where: [{ path: "year", op: "gte", value: 2021 }],
        }),
        ["second"],
      );
    })));

  test(`${engine}: inbound adjacency: neighbours page correctly`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const firstPage = yield* docs.findPage({
        collection: "papers",
        linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" },
        limit: 1,
      });
      assert.equal(firstPage.documents.length, 1);
      assert.ok(firstPage.next !== undefined, "another citing paper follows");
      const secondPage = yield* docs.findPage({
        collection: "papers",
        linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" },
        limit: 1,
        after: firstPage.next,
      });
      assert.equal(secondPage.documents.length, 1);
      assert.deepEqual(
        [...firstPage.documents, ...secondPage.documents].map((d) => d.id).sort(),
        ["first", "second"],
      );
      assert.equal(secondPage.next, undefined, "no more citing papers");
    })));

  test(`${engine}: inbound adjacency: target document is never re-versioned on source write`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const thirdBefore = yield* docs.findById({ collection: "papers", id: "third" });
      assert.equal(thirdBefore.version, 1);

      // Write a new paper citing "third"
      yield* docs.insert({
        collection: "papers",
        id: "newcomer",
        data: { cites: ["third"], field: "math", year: 2026 },
      });

      const thirdAfter = yield* docs.findById({ collection: "papers", id: "third" });
      assert.equal(thirdAfter.version, 1, "target version was not touched by incoming edge write");
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" } }),
        ["first", "newcomer", "second"],
      );
    })));

  test(`${engine}: inbound adjacency: retraction and updates drop reverse edge postings`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Delete "first"
      yield* docs.delete({ collection: "papers", id: "first" });
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" } }),
        ["second"],
      );
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "fourth", edge: "cites", direction: "inbound" } }),
        [],
      );

      // Update "second" to no longer cite "third"
      yield* docs.update({
        collection: "papers",
        id: "second",
        data: { cites: [], field: "chemistry", year: 2021 },
      });
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "third", edge: "cites", direction: "inbound" } }),
        [],
      );

      // Update "second" to cite "fourth"
      yield* docs.update({
        collection: "papers",
        id: "second",
        data: { cites: ["fourth"], field: "chemistry", year: 2021 },
      });
      assert.deepEqual(
        yield* find(docs, { linked: { collection: "papers", id: "fourth", edge: "cites", direction: "inbound" } }),
        ["second"],
      );
    })));

  test(`${engine}: inbound adjacency works across different collections`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "posts" });
      yield* docs.createCollection({
        name: "comments",
        edges: [{ name: "on_post", path: "postId", collection: "posts" }],
      });

      yield* docs.insert({ collection: "posts", id: "post-1", data: { title: "First" } });
      yield* docs.insert({ collection: "posts", id: "post-2", data: { title: "Second" } });
      yield* docs.insert({ collection: "comments", id: "c1", data: { postId: "post-1", text: "great" } });
      yield* docs.insert({ collection: "comments", id: "c2", data: { postId: "post-1", text: "agree" } });
      yield* docs.insert({ collection: "comments", id: "c3", data: { postId: "post-2", text: "disagree" } });

      // Inbound query on comments linking to post-1
      const commentsOnPost1 = yield* docs.findMany({
        collection: "comments",
        linked: { collection: "comments", id: "post-1", edge: "on_post", direction: "inbound" },
      });
      assert.deepEqual(commentsOnPost1.map((c) => c.id).sort(), ["c1", "c2"]);

      // Specifying collection as target "posts" also resolves seamlessly
      const viaPostsCollection = yield* docs.findMany({
        collection: "comments",
        linked: { collection: "posts", id: "post-1", edge: "on_post", direction: "inbound" },
      });
      assert.deepEqual(viaPostsCollection.map((c) => c.id).sort(), ["c1", "c2"]);
    })));

  test(`${engine}: bounded graph traversal (traverse) with depth, visit bounds and cycle handling`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Multi-hop outbound from "first":
      // first -> [second, third, fourth]
      // second -> [third]
      const outD1 = yield* docs.traverse({ collection: "papers", id: "first", edge: "cites", direction: "outbound", maxDepth: 1 });
      assert.deepEqual(outD1.documents.map((d) => d.id).sort(), ["fourth", "second", "third"]);
      assert.equal(outD1.maxDepthReached, 1);

      // Inbound traversal from "third":
      // Depth 1: cited by ["first", "second"]
      const inD1 = yield* docs.traverse({ collection: "papers", id: "third", edge: "cites", direction: "inbound", maxDepth: 1 });
      assert.deepEqual(inD1.documents.map((d) => d.id).sort(), ["first", "second"]);
      assert.equal(inD1.maxDepthReached, 1);

      // With visit limit: maxVisits: 1
      const limited = yield* docs.traverse({ collection: "papers", id: "third", edge: "cites", direction: "inbound", maxVisits: 1 });
      assert.equal(limited.documents.length, 1);
      assert.equal(limited.visited, 1);

      // Traversal with where filtering
      const filtered = yield* docs.traverse({
        collection: "papers", id: "third", edge: "cites", direction: "inbound",
        where: [{ path: "field", value: "physics" }],
      });
      assert.deepEqual(filtered.documents.map((d) => d.id), ["first"]);

      // Cycle handling: chain with cycle A -> B -> C -> A
      yield* docs.createCollection({
        name: "nodes",
        edges: [{ name: "link", path: "target", collection: "nodes" }],
      });
      yield* docs.insert({ collection: "nodes", id: "n3", data: { target: "n3" } });
      yield* docs.insert({ collection: "nodes", id: "n2", data: { target: "n3" } });
      yield* docs.insert({ collection: "nodes", id: "n1", data: { target: "n2" } });
      // Close the cycle: n3 links to n1
      yield* docs.update({ collection: "nodes", id: "n3", data: { target: "n1" } });

      const cycleResult = yield* docs.traverse({
        collection: "nodes", id: "n1", edge: "link", direction: "outbound", maxDepth: 10,
      });
      assert.deepEqual(cycleResult.documents.map((d) => d.id).sort(), ["n2", "n3"]);
      assert.equal(cycleResult.visited, 2);
    })));
}
