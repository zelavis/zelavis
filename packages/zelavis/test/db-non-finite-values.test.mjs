import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { documentsFor, domainEventsFor, defineDatabaseService } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runPluginsCommand } from "../dist/cli/plugins.js";
import { openTemporaryDatabase } from "./_database.mjs";

for (const [engine, open] of [
  ["memory", () => makeMemoryStore("shard")],
  ["sqlite", (directory) => makeNodeSqliteStore("shard", directory)],
]) {
  const setup = (t, body) => {
    const directory = mkdtempSync(join(tmpdir(), "zv-finite-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(directory);
      const docs = documentsFor(store, "tenant");
      const events = domainEventsFor(store, "tenant");
      yield* docs.createCollection({
        name: "records",
        indexes: [{ name: "score", fields: [{ path: "stats.score" }], unique: true }],
      });
      return yield* body(docs, events);
    })));
  };

  test(`${engine}: invalid indexed numbers refuse creates, updates, and batches without changing documents or events`, (t) =>
    setup(t, (docs, events) => Effect.gen(function* () {
      const original = yield* docs.insert({ collection: "records", id: "original", data: { stats: { score: 7 } } });
      const before = yield* events.read();
      for (const score of [NaN, Infinity, -Infinity]) {
        const bad = { stats: { score } };
        const operations = [
          docs.insert({ collection: "records", id: "bad", data: bad }),
          ...["merge", "replace"].map((mode) => docs.update({ collection: "records", id: "original", data: bad, mode })),
          docs.write({ operations: [
            { _tag: "Update", collection: "records", id: "original", data: { stats: { score: 8 } } },
            { _tag: "Insert", collection: "records", id: "bad", data: bad },
          ] }),
          docs.write({ operations: [
            { _tag: "Insert", collection: "records", id: "good", data: { stats: { score: 9 } } },
            { _tag: "Update", collection: "records", id: "original", data: bad },
          ] }),
        ];
        for (const operation of operations) {
          const failure = yield* Effect.flip(operation);
          assert.equal(failure._tag, "InvalidDocumentValue");
          assert.equal(failure.collection, "records");
          assert.equal(failure.path, "stats.score");
          assert.deepEqual(yield* docs.findById({ collection: "records", id: "original" }), original);
          assert.equal(yield* docs.findById({ collection: "records", id: "bad" }), undefined);
          assert.equal(yield* docs.findById({ collection: "records", id: "good" }), undefined);
          assert.deepEqual(yield* events.read(), before);
        }
      }
      assert.equal(yield* docs.forgetIdempotencyKeys(), 0);
      const valid = yield* docs.update({ collection: "records", id: "original", data: { stats: { score: -0 } } });
      assert.equal(valid.version, original.version + 1);
      assert.equal((yield* docs.findMany({ collection: "records", where: [{ path: "stats.score", op: "eq", value: 0 }] })).length, 1);
    })));

  test(`${engine}: non-finite values cannot replay null receipts or consume a fresh idempotency key`, (t) =>
    setup(t, (docs, events) => Effect.gen(function* () {
      const input = { collection: "records", id: "nullable", data: { score: null }, idempotencyKey: "null-insert" };
      yield* docs.insert(input);
      yield* docs.update({ ...input, idempotencyKey: "null-update" });
      yield* docs.write({ operations: [{ _tag: "Update", collection: "records", id: input.id, data: input.data }], idempotencyKey: "null-batch" });
      const before = yield* events.read();
      for (const score of [NaN, Infinity, -Infinity]) {
        for (const operation of [
          docs.insert({ ...input, data: { score } }),
          docs.update({ ...input, data: { score }, idempotencyKey: "null-update" }),
          docs.write({ operations: [{ _tag: "Update", collection: "records", id: input.id, data: { score } }], idempotencyKey: "null-batch" }),
        ]) assert.equal((yield* Effect.flip(operation))._tag, "InvalidDocumentValue");
      }
      assert.deepEqual(yield* events.read(), before);
      const retry = { collection: "records", id: "retry", idempotencyKey: "fresh" };
      assert.equal((yield* Effect.flip(docs.insert({ ...retry, data: { score: Infinity } })))._tag, "InvalidDocumentValue");
      const written = yield* docs.insert({ ...retry, data: { score: 42 } });
      assert.equal(written.data.score, 42);
      assert.equal(written.version, 1);
    })));
}

test("Promise and HTTP writes report validation failures; SDK and CLI never serialize invalid numbers as null", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("tenant");
  await tenant.documents.createCollection({ name: "records" });
  const before = await tenant.events.read();
  await assert.rejects(tenant.documents.insert({ collection: "records", id: "bad", data: { score: NaN } }), (error) => error._tag === "InvalidDocumentValue");
  const runtime = await createServiceRuntime({
    services: [defineDatabaseService(api)], prefix: "/api",
    resolvePrincipal: () => ({ id: "owner", type: "user", permissions: ["*"] }),
  });
  t.after(() => runtime.close());
  const path = "http://localhost/api/database/documents/records";
  for (const number of ["1e400", "-1e400"]) {
    const response = await runtime.fetch(new Request(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: `{"tenantId":"tenant","id":"bad","data":{"score":${number}}}`,
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /score.*indexed numbers must be finite/);
  }
  let writes = 0;
  const fetcher = (input, init) => {
    if (init?.method === "POST") writes++;
    return runtime.fetch(new Request(input, init));
  };
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "", apiVersion: "", fetch: fetcher });
  for (const score of [NaN, Infinity, -Infinity]) {
    await assert.rejects(client.json("/database/documents/records", {
      method: "POST", body: { tenantId: "tenant", data: { score } },
    }), /JSON request numbers must be finite/);
  }
  await assert.rejects(runtime.plain({ url: "/api/database/documents/records", method: "POST", body: { tenantId: "tenant", data: { score: Infinity } } }), /JSON request numbers must be finite/);
  t.mock.method(globalThis, "fetch", (input, init) => {
    if (String(input).endsWith("/runtime/plugin-operations")) return Promise.resolve(Response.json({ operations: [{
      namespace: "fixture", resource: "records", action: "create", method: "POST", path: "/database/documents/records",
    }] }));
    return fetcher(input, init);
  });
  await assert.rejects(runPluginsCommand(["fixture", "records", "create", "--url", "http://localhost", "--data", '{"tenantId":"tenant","data":{"score":1e400}}']), /JSON request numbers must be finite/);
  assert.equal(writes, 0);
  assert.deepEqual(await tenant.events.read(), before);
  assert.equal(await tenant.documents.findById({ collection: "records", id: "bad" }), undefined);
});
