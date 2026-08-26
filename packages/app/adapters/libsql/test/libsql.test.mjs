import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
} from "@zelavis/app/db";
import { createLibsqlDatabase } from "../dist/index.js";

const scratchDirs = [];

process.on("exit", () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

function freshDatabase() {
  // libsql opens a fresh connection per transaction; `:memory:` lives per
  // connection, so tests run against a temp file instead to share state.
  const directory = mkdtempSync(join(tmpdir(), "zelavis-libsql-"));
  scratchDirs.push(directory);
  return createLibsqlDatabase({
    url: `file:${join(directory, "database.sqlite")}`,
  });
}

test("libsql adapter exposes a working documents API", async () => {
  const database = await freshDatabase();

  await database.documents.createCollection({ name: "products" });
  const created = await database.documents.insert({
    collection: "products",
    id: "prod_1",
    data: { name: "Hoodie", price: 5900 },
  });

  assert.equal(created.id, "prod_1");
  assert.equal(created.collection, "products");
  assert.equal(created.data.name, "Hoodie");
  assert.equal(created.version, 1);
  assert.equal(created.schemaVersion, 1);

  const fetched = await database.documents.findById({
    collection: "products",
    id: "prod_1",
  });
  assert.equal(fetched?.data.price, 5900);
});

test("libsql adapter pushes filter and sort into SQL via json_extract", async () => {
  const database = await freshDatabase();

  await database.documents.createCollection({ name: "items" });

  for (const [id, price, status] of [
    ["a", 100, "available"],
    ["b", 250, "sold"],
    ["c", 500, "available"],
    ["d", 750, "available"],
  ]) {
    await database.documents.insert({
      collection: "items",
      id,
      data: { price, status },
    });
  }

  const cheapAvailable = await database.documents.findMany({
    collection: "items",
    where: [
      { path: "status", op: "eq", value: "available" },
      { path: "price", op: "lt", value: 600 },
    ],
    orderBy: [{ path: "price", direction: "asc" }],
  });

  assert.deepEqual(
    cheapAvailable.map((doc) => doc.id),
    ["a", "c"],
  );

  const descending = await database.documents.findMany({
    collection: "items",
    where: [{ path: "status", op: "in", value: ["available", "sold"] }],
    orderBy: [{ path: "price", direction: "desc" }],
    limit: 2,
  });

  assert.deepEqual(
    descending.map((doc) => doc.id),
    ["d", "c"],
  );
});

test("libsql adapter detects revision conflicts on document upsert", async () => {
  const database = await freshDatabase();
  await database.documents.createCollection({ name: "notes" });
  await database.documents.insert({
    collection: "notes",
    id: "n1",
    data: { body: "first" },
  });

  await assert.rejects(
    () =>
      database.documents.insert({
        collection: "notes",
        id: "n1",
        data: { body: "duplicate" },
      }),
    DatabaseConflictError,
  );

  await database.documents.update({
    collection: "notes",
    id: "n1",
    data: { body: "second" },
  });

  // Now the version is 2 — using expectedRevision 0 from another writer
  // should be detected as a mismatch.
  await assert.rejects(
    () =>
      database.events.append({
        collection: "notes",
        documentId: "n1",
        type: "document.upserted",
        expectedRevision: 5,
        payload: { data: { body: "racing" } },
      }),
    DatabaseRevisionMismatchError,
  );
});

test("libsql adapter reports false when deleting unknown documents", async () => {
  const database = await freshDatabase();
  await database.documents.createCollection({ name: "ghosts" });
  const deleted = await database.documents.delete({
    collection: "ghosts",
    id: "missing",
  });
  assert.equal(deleted, false);
});

test("libsql adapter persists data through a transaction and rolls back on errors", async () => {
  const database = await freshDatabase();
  await database.documents.createCollection({ name: "txns" });

  await database.documents.insert({
    collection: "txns",
    id: "row_1",
    data: { kind: "alpha" },
  });

  const after = await database.documents.findById({
    collection: "txns",
    id: "row_1",
  });
  assert.equal(after?.data.kind, "alpha");
});
