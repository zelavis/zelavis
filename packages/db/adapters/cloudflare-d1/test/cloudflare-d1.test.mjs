import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
} from "@zelavis/db";
import {
  createCloudflareD1Database,
  createCloudflareD1DatabaseDriver,
} from "../dist/index.js";

/**
 * Minimal D1-compatible mock backed by `better-sqlite3`.
 *
 * Real Cloudflare D1 is async, but the public surface (prepare → bind → run
 * / all, plus batch) is identical to what we model here. Tests verify the
 * adapter's translation layer (deferred writes, batch atomicity, JSON
 * pushdown queries) without depending on Wrangler or miniflare.
 */
function createMockD1Database() {
  const database = new Database(":memory:");

  function prepareStatement(sql) {
    let boundParams = [];

    const statement = {
      bind(...values) {
        boundParams = values.map((value) => (value === undefined ? null : value));
        return statement;
      },
      async all() {
        const compiled = database.prepare(sql);
        const rows = compiled.reader
          ? compiled.all(...boundParams)
          : (compiled.run(...boundParams), []);
        return {
          success: true,
          results: rows,
          meta: { changes: 0, last_row_id: 0 },
        };
      },
      async run() {
        const compiled = database.prepare(sql);
        const info = compiled.run(...boundParams);
        return {
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
    };

    return statement;
  }

  const mock = {
    prepare(sql) {
      return prepareStatement(sql);
    },
    async batch(statements) {
      // D1 batches run atomically inside a transaction.
      const tx = database.transaction(() => {
        const results = [];
        for (const statement of statements) {
          // The recorded statement still has its bound params from `.bind()`.
          const run = statement.runSync ?? statement.run;
          // We can't actually `await` inside the sync transaction, so reach
          // into our mock's underlying knowledge by re-running synchronously.
          // We do this by stashing the SQL/params on the statement and
          // executing them here.
          results.push(statement.__execSync());
        }
        return results;
      });
      return tx();
    },
  };

  return { mock, database };
}

/**
 * Sync-friendly variant of the mock so `batch()` can run inside a
 * better-sqlite3 sync transaction wrapper.
 */
function createSyncMockD1Database() {
  const database = new Database(":memory:");

  function prepareStatement(sql) {
    let boundParams = [];

    const statement = {
      bind(...values) {
        boundParams = values.map((value) => (value === undefined ? null : value));
        return statement;
      },
      __execSync() {
        const compiled = database.prepare(sql);
        if (compiled.reader) {
          return compiled.all(...boundParams);
        }
        const info = compiled.run(...boundParams);
        return {
          changes: info.changes,
          last_row_id: Number(info.lastInsertRowid ?? 0),
        };
      },
      async all() {
        const compiled = database.prepare(sql);
        const rows = compiled.reader ? compiled.all(...boundParams) : [];
        return {
          success: true,
          results: rows,
          meta: { changes: 0, last_row_id: 0 },
        };
      },
      async run() {
        const compiled = database.prepare(sql);
        const info = compiled.run(...boundParams);
        return {
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
    };

    return statement;
  }

  return {
    prepare(sql) {
      return prepareStatement(sql);
    },
    async batch(statements) {
      const tx = database.transaction(() => {
        const results = [];
        for (const statement of statements) {
          results.push(statement.__execSync());
        }
        return results;
      });
      return tx();
    },
  };
}

test("cloudflare-d1 adapter writes and reads documents through the D1 API", async () => {
  const database = await createCloudflareD1Database({
    database: createSyncMockD1Database(),
  });

  await database.documents.createCollection({ name: "products" });
  const created = await database.documents.insert({
    collection: "products",
    id: "prod_1",
    data: { name: "Hoodie", price: 5900 },
  });

  assert.equal(created.id, "prod_1");
  assert.equal(created.version, 1);

  const fetched = await database.documents.findById({
    collection: "products",
    id: "prod_1",
  });
  assert.equal(fetched?.data.price, 5900);
});

test("cloudflare-d1 adapter pushes filter and sort into SQL via json_extract", async () => {
  const database = await createCloudflareD1Database({
    database: createSyncMockD1Database(),
  });

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

  const filtered = await database.documents.findMany({
    collection: "items",
    where: [
      { path: "status", op: "eq", value: "available" },
      { path: "price", op: "lt", value: 600 },
    ],
    orderBy: [{ path: "price", direction: "asc" }],
  });

  assert.deepEqual(
    filtered.map((doc) => doc.id),
    ["a", "c"],
  );
});

test("cloudflare-d1 adapter detects revision conflicts on duplicate inserts", async () => {
  const database = await createCloudflareD1Database({
    database: createSyncMockD1Database(),
  });
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
});

test("cloudflare-d1 adapter detects revision mismatches on append", async () => {
  const database = await createCloudflareD1Database({
    database: createSyncMockD1Database(),
  });
  await database.documents.createCollection({ name: "stream" });
  await database.documents.insert({
    collection: "stream",
    id: "s1",
    data: { v: 1 },
  });

  await assert.rejects(
    () =>
      database.events.append({
        collection: "stream",
        documentId: "s1",
        type: "document.upserted",
        expectedRevision: 99,
        payload: { data: { v: 2 } },
      }),
    DatabaseRevisionMismatchError,
  );
});

test("createCloudflareD1DatabaseDriver reports the expected capabilities", () => {
  const driver = createCloudflareD1DatabaseDriver({
    database: createSyncMockD1Database(),
  });
  assert.equal(driver.name, "cloudflare-d1");
  assert.equal(driver.capabilities.documents, true);
  assert.equal(driver.capabilities.events, true);
  assert.equal(driver.capabilities.sql, true);
  assert.equal(driver.capabilities.transactions, true);
});
