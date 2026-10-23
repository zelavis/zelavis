import assert from "node:assert/strict";
import test from "node:test";

import { openTemporaryDatabase } from "./_database.mjs";

test("dropping a collection takes its documents and its lenses with it", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("acme");
  await tenant.documents.createCollection({
    name: "notes",
    indexes: [{ name: "by_topic", fields: [{ path: "topic" }] }],
  });
  for (const topic of ["alpha", "beta", "gamma"]) {
    await tenant.documents.insert({ collection: "notes", data: { topic } });
  }
  assert.equal((await tenant.documents.findMany({ collection: "notes" })).length, 3);

  assert.equal(await tenant.documents.dropCollection({ name: "notes" }), true);
  assert.equal(await tenant.documents.collectionExists("notes"), false);
  assert.deepEqual(
    (await tenant.documents.listCollections()).map((c) => c.name),
    [],
  );

  // The name is free again, and the new collection is genuinely empty —
  // nothing survived in a lens to be found by the index that outlived it.
  await tenant.documents.createCollection({ name: "notes" });
  assert.deepEqual(await tenant.documents.findMany({ collection: "notes" }), []);
  assert.deepEqual(
    await tenant.documents.findMany({ collection: "notes", where: [{ path: "topic", value: "alpha" }] }),
    [],
  );
});

test("dropping is refused while another collection references it", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("acme");
  await tenant.documents.createCollection({ name: "authors" });
  await tenant.documents.createCollection({
    name: "books",
    references: [{ name: "writer", path: "authorId", collection: "authors" }],
  });

  await assert.rejects(
    tenant.documents.dropCollection({ name: "authors" }),
    (error) => error._tag === "ReferenceViolation" && /books still references it/u.test(error.reason),
    "a reference is a promise the other collection's documents rely on",
  );

  // Dropping the collection that holds the reference works, and then the
  // target can go too.
  assert.equal(await tenant.documents.dropCollection({ name: "books" }), true);
  assert.equal(await tenant.documents.dropCollection({ name: "authors" }), true);
});

test("dropping a collection that is not there says so rather than pretending", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  await assert.rejects(
    api.forTenant("acme").documents.dropCollection({ name: "absent" }),
    (error) => error._tag === "CollectionNotFound",
  );
});

test("a tenant whose collections are all gone still holds its history, and stays an occupant", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  await api.forTenant("ghost").documents.createCollection({ name: "temp" });
  await api.forTenant("stays").documents.createCollection({ name: "kept" });
  assert.deepEqual(await api.tenants(), ["ghost", "stays"]);

  await api.forTenant("ghost").documents.dropCollection({ name: "temp" });
  assert.deepEqual(await api.forTenant("ghost").documents.listCollections(), []);
  // Its log, its identifier counter and its retired records are still its own:
  // a move that left them behind would let it start its identifiers and log
  // positions over, under every cursor handed out before.
  assert.deepEqual(await api.tenants(), ["ghost", "stays"]);
  assert.ok((await api.forTenant("ghost").events.read({})).events.length > 0, "its history is still there");
});

test("a tenant is an occupant from its first write, whatever that write holds", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  assert.deepEqual(await api.tenants(), []);
  // No collection at all: only a message in its outbox.
  await api.forTenant("messenger").outbox.emit({ topic: "hello", payload: {} });
  assert.deepEqual(await api.tenants(), ["messenger"]);
});
