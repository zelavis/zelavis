// Constraints: what a collection refuses, decided in the transaction that writes.
//
// Every check here reads the store under its one writer, so a violation is
// either refused or impossible — never one that slipped in between a check and
// a write. These pin that, and what each constraint means at its edges: a
// missing value, a typed value, documents that broke a rule before it existed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
import { documentsFor, schemasFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

for (const [engine, open] of engines) {
  const setup = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-constraints-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      return yield* body(documentsFor(store, "t1", schemasFor(store, "t1")), store);
    })));
  };
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
  const into = (docs, collection) => ({
    insert: (id, data, extra = {}) => docs.insert({ collection, id, data, ...extra }),
    update: (id, data, extra = {}) => docs.update({ collection, id, data, ...extra }),
    remove: (id, extra = {}) => docs.delete({ collection, id, ...extra }),
    get: (id) => docs.findById({ collection, id }),
    record: () => Effect.map(docs.listCollections, (all) => all.find((c) => c.name === collection)),
  });

  test(`${engine}: a unique index refuses a second holder of its values, and not a document missing one`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "users", indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }],
      });
      const users = into(docs, "users");
      yield* users.insert("a", { email: "a@x" });
      const taken = yield* Effect.flip(users.insert("b", { email: "a@x" }));
      assert.equal(taken._tag, "UniqueViolation");
      assert.equal(taken.index, "by_email");
      assert.equal(taken.holder, "a");
      assert.equal(yield* users.get("b"), undefined, "a refused insert leaves nothing behind");
      // Typed, as the lens is: the number 1 and the string "1" are two values.
      yield* users.insert("n", { email: 1 });
      yield* users.insert("s", { email: "1" });
      // No value is not a value: any number of documents may lack one.
      yield* users.insert("c", {});
      yield* users.insert("d", { email: null });
      yield* users.insert("e", { email: null });
      // A document keeps its own values through an update, and frees them when deleted.
      yield* users.update("a", { name: "A" });
      assert.equal(yield* tagOf(users.update("c", { email: "a@x" })), "UniqueViolation");
      yield* users.remove("a");
      yield* users.update("c", { email: "a@x" });
    })));

  test(`${engine}: a unique index over several fields holds the combination`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "handles",
        indexes: [{ name: "by_org_handle", fields: [{ path: "org" }, { path: "handle", direction: "desc" }], unique: true }],
      });
      const handles = into(docs, "handles");
      yield* handles.insert("a", { org: "x", handle: "h" });
      yield* handles.insert("b", { org: "y", handle: "h" });
      assert.equal(yield* tagOf(handles.insert("c", { org: "x", handle: "h" })), "UniqueViolation");
      yield* handles.insert("d", { org: "x" });
      yield* handles.insert("e", { org: "x" });
    })));

  test(`${engine}: a unique index over documents that already break it is not created`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "users" });
      const users = into(docs, "users");
      for (const [id, data] of [["a", { email: "dup" }], ["b", { email: "dup" }], ["c", { email: "c" }], ["d", {}], ["e", {}]]) {
        yield* users.insert(id, data);
      }
      const definition = { collection: "users", name: "by_email", fields: [{ path: "email" }], unique: true };
      const refused = yield* Effect.flip(docs.createIndex(definition));
      assert.equal(refused._tag, "UniqueViolation");
      assert.deepEqual([refused.holder, refused.id], ["a", "b"]);
      assert.deepEqual((yield* users.record()).indexes ?? [], [], "and it is not left behind half made");

      yield* users.update("b", { email: "b" });
      const index = yield* docs.createIndex(definition);
      assert.deepEqual([index.state, index.unique], ["ready", true]);
      assert.equal(yield* tagOf(users.insert("f", { email: "c" })), "UniqueViolation");
      // The same name without `unique` is a different index.
      assert.equal(yield* tagOf(docs.createIndex({ ...definition, unique: false })), "IndexExists");
    })));

  test(`${engine}: a check refuses what it does not allow, and passes a field with no value`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const checks = [
        { name: "price_not_negative", where: [{ path: "price", op: "gte", value: 0 }] },
        { name: "known_status", where: [{ path: "status", op: "in", value: ["draft", "live"] }] },
      ];
      yield* docs.createCollection({ name: "products", checks });
      const products = into(docs, "products");
      yield* products.insert("p1", { price: 5, status: "draft" });
      const refused = yield* Effect.flip(products.insert("p2", { price: -1 }));
      assert.equal(refused._tag, "CheckViolation");
      assert.equal(refused.check, "price_not_negative");
      assert.match(refused.reason, /price gte 0/);
      yield* products.insert("p3", {});
      yield* products.insert("p4", { price: null });
      // Compared like with like: a string is not a number at or above zero.
      assert.equal(yield* tagOf(products.insert("p5", { price: "5" })), "CheckViolation");
      assert.equal(yield* tagOf(products.insert("p6", { status: "gone" })), "CheckViolation");
      assert.equal(yield* tagOf(products.update("p1", { price: -5 })), "CheckViolation");
      const kept = yield* products.get("p1");
      assert.deepEqual([kept.data.price, kept.version], [5, 1], "a refused update changes nothing");
      assert.deepEqual((yield* products.record()).checks, [
        { name: "price_not_negative", where: [{ path: "price", op: "gte", value: 0 }] },
        { name: "known_status", where: [{ path: "status", op: "in", value: ["draft", "live"] }] },
      ]);
    })));

  test(`${engine}: a check added over documents that break it is taken away again, naming one`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "products" });
      const products = into(docs, "products");
      for (const [id, data] of [["a", { price: 5 }], ["b", { price: -2 }], ["c", {}]]) yield* products.insert(id, data);
      const check = { collection: "products", name: "non_negative", where: [{ path: "price", op: "gte", value: 0 }] };
      const refused = yield* Effect.flip(docs.addCheck(check));
      assert.equal(refused._tag, "CheckViolation");
      assert.equal(refused.id, "b");
      assert.match(refused.reason, /not added/);
      assert.deepEqual((yield* products.record()).checks ?? [], []);
      yield* products.insert("d", { price: -3 });

      yield* products.update("b", { price: 2 });
      yield* products.remove("d");
      assert.deepEqual(yield* docs.addCheck(check), { name: "non_negative", where: check.where });
      assert.equal(yield* tagOf(products.insert("e", { price: -1 })), "CheckViolation");
      assert.equal(yield* tagOf(docs.addCheck(check)), "ConstraintExists");

      const add = (definition) => tagOf(docs.addCheck({ collection: "products", ...definition }));
      assert.equal(yield* add({ name: "bad name", where: check.where }), "InvalidConstraint");
      assert.equal(yield* add({ name: "empty", where: [] }), "InvalidConstraint");
      assert.equal(yield* add({ name: "like", where: [{ path: "name", op: "like", value: "a%" }] }), "InvalidConstraint");
      assert.equal(yield* add({ name: "listless", where: [{ path: "status", op: "in", value: "draft" }] }), "InvalidConstraint");
      assert.equal(yield* tagOf(docs.addCheck({ ...check, collection: "nowhere" })), "CollectionNotFound");

      assert.equal(yield* docs.dropCheck({ collection: "products", name: "non_negative" }), true);
      assert.equal(yield* docs.dropCheck({ collection: "products", name: "non_negative" }), false);
      yield* products.insert("f", { price: -1 });
    })));

  test(`${engine}: a precondition is a compare-and-set on the document as it stands`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "posts" });
      const posts = into(docs, "posts");
      yield* posts.insert("p", { status: "draft", title: "t" });
      const draft = [{ path: "status", value: "draft" }];
      const live = yield* posts.update("p", { status: "live" }, { precondition: draft });
      assert.equal(live.version, 2);
      const stale = yield* Effect.flip(posts.update("p", { title: "x" }, { precondition: draft }));
      assert.equal(stale._tag, "DocumentConflict");
      assert.match(stale.reason, /does not match status eq "draft"/);
      assert.equal(yield* tagOf(posts.remove("p", { precondition: draft })), "DocumentConflict");
      assert.equal(yield* tagOf(posts.update("p", { title: "y" }, { expectedVersion: 1 })), "DocumentConflict");
      assert.equal(yield* posts.remove("p", { precondition: [{ path: "status", value: "live" }] }), true);
    })));

  test(`${engine}: writes racing each other are decided one at a time`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "posts", indexes: [{ name: "by_slug", fields: [{ path: "slug" }], unique: true }],
      });
      const posts = into(docs, "posts");
      yield* posts.insert("p", { slug: "p" });
      const race = (...effects) => Effect.all(effects.map((effect) => Effect.exit(effect)), { concurrency: "unbounded" });
      const landed = (exits) => exits.filter(Exit.isSuccess).length;

      assert.equal(landed(yield* race(
        posts.update("p", { a: 1 }, { expectedVersion: 1 }),
        posts.update("p", { b: 2 }, { expectedVersion: 1 }),
      )), 1, "two updates built on one version: one lands, the other is told");
      yield* race(posts.update("p", { x: 1 }), posts.update("p", { y: 2 }));
      const merged = (yield* posts.get("p")).data;
      assert.deepEqual([merged.x, merged.y], [1, 2], "each merge builds on what the other wrote");
      assert.equal(landed(yield* race(posts.insert("q1", { slug: "s" }), posts.insert("q2", { slug: "s" }))), 1);
      assert.equal(landed(yield* race(posts.insert("r", { slug: "r1" }), posts.insert("r", { slug: "r2" }))), 1);
    })));

  test(`${engine}: a refused keyed write records nothing, so its key is still free`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({
        name: "products", checks: [{ name: "non_negative", where: [{ path: "price", op: "gte", value: 0 }] }],
      });
      const products = into(docs, "products");
      const bad = products.insert("p", { price: -1 }, { idempotencyKey: "k1" });
      assert.equal(yield* tagOf(bad), "CheckViolation");
      assert.equal(yield* tagOf(bad), "CheckViolation", "refused again, not answered from a receipt");
      const first = yield* products.insert("p", { price: 1 }, { idempotencyKey: "k2" });
      const replay = yield* products.insert("p", { price: 1 }, { idempotencyKey: "k2" });
      assert.deepEqual(replay, first);
    })));

  const library = (docs, postsOnDelete = {}) => Effect.gen(function* () {
    yield* docs.createCollection({ name: "authors" });
    yield* docs.createCollection({
      name: "posts",
      references: [{ name: "author", path: "authorId", collection: "authors", ...postsOnDelete }],
    });
    return { authors: into(docs, "authors"), posts: into(docs, "posts") };
  });

  test(`${engine}: a reference refuses a document naming one that does not exist, within its own tenant`, (t) =>
    setup(t, (docs, store) => Effect.gen(function* () {
      const { authors, posts } = yield* library(docs);
      yield* authors.insert("a1", { name: "Ann" });
      yield* posts.insert("p1", { authorId: "a1" });
      const orphan = yield* Effect.flip(posts.insert("p2", { authorId: "ghost" }));
      assert.equal(orphan._tag, "ReferenceViolation");
      assert.equal(orphan.reference, "author");
      assert.match(orphan.reason, /no document "ghost" in "authors"/);
      yield* posts.insert("p3", {});
      yield* posts.insert("p4", { authorId: null });
      assert.match((yield* Effect.flip(posts.insert("p5", { authorId: 7 }))).reason, /not a document id/);
      assert.equal(yield* tagOf(posts.update("p1", { authorId: "ghost" })), "ReferenceViolation");

      // Another tenant's author, on the same shard, is not this tenant's.
      const other = documentsFor(store, "t2");
      yield* other.createCollection({ name: "authors" });
      yield* other.insert({ collection: "authors", id: "elsewhere", data: {} });
      assert.equal(yield* tagOf(posts.insert("p6", { authorId: "elsewhere" })), "ReferenceViolation");

      assert.deepEqual((yield* authors.record()).referencedBy, [{ collection: "posts", reference: "author" }]);
      assert.deepEqual((yield* posts.record()).references,
        [{ name: "author", path: "authorId", collection: "authors", onDelete: "restrict" }]);
    })));

  test(`${engine}: deleting a named document is refused while a restricting reference names it`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const { authors, posts } = yield* library(docs);
      yield* authors.insert("a1", {});
      yield* posts.insert("p1", { authorId: "a1" });
      const refused = yield* Effect.flip(authors.remove("a1"));
      assert.equal(refused._tag, "ReferenceViolation");
      assert.equal(refused.reference, "posts.author");
      assert.match(refused.reason, /"p1" in "posts" names it/);
      assert.notEqual(yield* authors.get("a1"), undefined);
      yield* posts.update("p1", { authorId: null });
      assert.equal(yield* authors.remove("a1"), true);
    })));

  test(`${engine}: a cascade deletes down the chain, each document once, in one transaction`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const { authors, posts } = yield* library(docs, { onDelete: "cascade" });
      yield* docs.createCollection({
        name: "comments",
        references: [
          { name: "post", path: "postId", collection: "posts", onDelete: "cascade" },
          { name: "author", path: "authorId", collection: "authors", onDelete: "set-null" },
        ],
      });
      const comments = into(docs, "comments");
      yield* authors.insert("a1", {});
      yield* authors.insert("a2", {});
      yield* posts.insert("p1", { authorId: "a1" });
      yield* posts.insert("p2", { authorId: "a1" });
      yield* posts.insert("p3", { authorId: "a2" });
      // c1 is reached twice: through its post, which cascades, and through its
      // author, which clears. Deleted is what it ends as.
      yield* comments.insert("c1", { postId: "p1", authorId: "a1" });
      yield* comments.insert("c2", { postId: "p2" });
      yield* comments.insert("c3", { postId: "p3", authorId: "a1" });

      assert.equal(yield* authors.remove("a1"), true);
      for (const [label, found] of [["p1", yield* posts.get("p1")], ["p2", yield* posts.get("p2")],
        ["c1", yield* comments.get("c1")], ["c2", yield* comments.get("c2")]]) {
        assert.equal(found, undefined, `${label} went with its author`);
      }
      const survivor = yield* comments.get("c3");
      assert.equal(survivor.data.authorId, null, "a comment on another author's post only loses its author");
      assert.notEqual(yield* posts.get("p3"), undefined);

      // A cycle ends where it began rather than going round again.
      yield* docs.createCollection({
        name: "nodes", references: [{ name: "parent", path: "parent", collection: "nodes", onDelete: "cascade" }],
      });
      const nodes = into(docs, "nodes");
      yield* nodes.insert("self", { parent: "self" });
      yield* nodes.insert("n1", {});
      yield* nodes.insert("n2", { parent: "n1" });
      yield* nodes.insert("n3", { parent: "n2" });
      yield* nodes.update("n1", { parent: "n3" });
      assert.equal(yield* nodes.remove("n1"), true);
      for (const id of ["n1", "n2", "n3"]) assert.equal(yield* nodes.get(id), undefined, `${id} is gone`);
      assert.notEqual(yield* nodes.get("self"), undefined);
    })));

  test(`${engine}: set-null clears every field naming the document, and the document must still be valid`, (t) =>
    setup(t, (docs, store) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "authors" });
      yield* docs.createCollection({
        name: "posts",
        references: [
          { name: "author", path: "authorId", collection: "authors", onDelete: "set-null" },
          { name: "editor", path: "roles.editorId", collection: "authors", onDelete: "set-null" },
        ],
      });
      const authors = into(docs, "authors");
      const posts = into(docs, "posts");
      yield* authors.insert("a1", {});
      yield* posts.insert("p1", { authorId: "a1", roles: { editorId: "a1" }, title: "t" });
      yield* authors.remove("a1");
      const cleared = yield* posts.get("p1");
      assert.deepEqual([cleared.data.authorId, cleared.data.roles.editorId, cleared.data.title, cleared.version],
        [null, null, "t", 2]);

      // A schema requiring the field makes clearing it impossible, so the
      // delete is refused whole rather than leaving an invalid document.
      yield* docs.createCollection({ name: "books", references: [{ name: "author", path: "authorId", collection: "authors", onDelete: "set-null" }] });
      const books = into(docs, "books");
      yield* authors.insert("a2", {});
      yield* books.insert("b1", { authorId: "a2" });
      yield* schemasFor(store, "t1").save({
        collection: "books", version: 1, activate: true,
        fields: [{ name: "authorId", field: { _tag: "TextField", label: "Author", required: true } }],
      });
      assert.equal(yield* tagOf(authors.remove("a2")), "SchemaViolation");
      assert.notEqual(yield* authors.get("a2"), undefined);
      assert.equal((yield* books.get("b1")).data.authorId, "a2");
    })));

  test(`${engine}: a reference added over documents that break it is taken away again`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "authors" });
      yield* docs.createCollection({ name: "posts" });
      const authors = into(docs, "authors");
      const posts = into(docs, "posts");
      yield* authors.insert("a1", {});
      yield* posts.insert("p1", { authorId: "a1" });
      yield* posts.insert("p2", { authorId: "ghost" });
      const reference = { from: "posts", name: "author", path: "authorId", collection: "authors" };
      const refused = yield* Effect.flip(docs.addReference(reference));
      assert.equal(refused._tag, "ReferenceViolation");
      assert.equal(refused.id, "p2");
      assert.match(refused.reason, /not added/);
      assert.deepEqual((yield* posts.record()).references ?? [], []);
      assert.deepEqual((yield* authors.record()).referencedBy ?? [], []);

      yield* posts.update("p2", { authorId: "a1" });
      assert.deepEqual(yield* docs.addReference(reference),
        { name: "author", path: "authorId", collection: "authors", onDelete: "restrict" });
      assert.equal(yield* tagOf(authors.remove("a1")), "ReferenceViolation");
      assert.equal(yield* tagOf(docs.addReference(reference)), "ConstraintExists");
      assert.equal(yield* tagOf(docs.addReference({ ...reference, name: "lost", collection: "nobody" })), "InvalidConstraint");
      assert.equal(yield* tagOf(docs.addReference({ ...reference, name: "boom", onDelete: "explode" })), "InvalidConstraint");

      assert.equal(yield* docs.dropReference({ collection: "posts", name: "author" }), true);
      assert.deepEqual((yield* authors.record()).referencedBy, []);
      assert.equal(yield* authors.remove("a1"), true);
      assert.equal(yield* docs.dropReference({ collection: "posts", name: "author" }), false);
    })));
}
