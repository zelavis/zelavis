// What a returned commit survives is a choice made when a database opens:
// `crash` (the default) or `power`. Each engine either keeps the stronger
// promise or refuses it; none quietly gives the weaker one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { sqliteKvEngineOver } from "../dist/db/engines/sqlite-kv.js";
import { makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";
import { engineAvailable } from "./_engine-available.mjs";

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-durability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("sqlite flushes every commit only when asked for power", (t) => {
  const dir = temp(t);
  // synchronous is per connection, so it is read on the connection the engine writes through.
  const synchronous = (durability) => {
    const file = join(dir, `s-${durability}.sqlite`);
    const db = new DatabaseSync(file);
    try {
      sqliteKvEngineOver(db, { openReader: () => new DatabaseSync(file, { readOnly: true }), durability });
      return db.prepare("PRAGMA synchronous").get().synchronous;
    } finally { db.close(); }
  };
  assert.equal(synchronous("crash"), 1, "NORMAL: the WAL survives a crash");
  assert.equal(synchronous("power"), 2, "FULL: the WAL is synced at every commit");
});

test("openNodeDatabase validates durability, refuses what an engine cannot keep, and reports it in health", async (t) => {
  const dir = temp(t);
  await assert.rejects(openNodeDatabase({ directory: join(dir, "a"), engine: { durability: "sometimes" } }), /Unsupported durability "sometimes"/);
  await assert.rejects(openNodeDatabase({ directory: join(dir, "b"), engine: { name: "rocksdb", durability: "power" } }), /cannot flush every commit/);
  await assert.rejects(openNodeDatabase({ directory: join(dir, "c"), engine: { flush: true } }), /accepts name and durability/);
  for (const durability of [undefined, "power"]) {
    const opened = await openNodeDatabase({ directory: join(dir, `d-${durability}`), ...(durability ? { engine: { durability } } : {}) });
    try {
      assert.deepEqual(opened.api.context.storage, { engine: "sqlite", durability: durability ?? "crash" });
      await opened.api.forTenant("acme").documents.createCollection({ name: "notes" });
      await opened.api.forTenant("acme").documents.insert({ collection: "notes", id: "a", data: { n: 1 } });
    } finally { await opened.close(); }
    const reopened = await openNodeDatabase({ directory: join(dir, `d-${durability}`), ...(durability ? { engine: { durability } } : {}) });
    try { assert.equal((await reopened.api.forTenant("acme").documents.findById({ collection: "notes", id: "a" })).data.n, 1); }
    finally { await reopened.close(); }
  }
});

test("rocksdb refuses power durability at open; lmdb keeps it", { skip: engineAvailable("@harperfast/rocksdb-js") && engineAvailable("lmdb") ? false : "optional engine unavailable" }, async (t) => {
  const dir = temp(t);
  const refused = await Effect.runPromise(Effect.scoped(Effect.flip(makeRocksdbJsStore("r", dir, { durability: "power" }))));
  assert.equal(refused._tag, "StoreError");
  assert.match(String(refused.cause), /cannot flush every commit/);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = (yield* makeLmdbStore("l", dir, { durability: "power" })).partition("acme");
    yield* store.transact((txn) => txn.put(1, new TextEncoder().encode("x"), { terms: [], columns: [], measures: [], edges: [] }, { namespace: "n", key: "k" }));
    assert.equal((yield* store.stats).records, 1);
  })));
});

test("a database records its durability for its next open, reports it pending until then, and the routes, SDK and CLI agree", async (t) => {
  const { defineDatabaseService } = await import("../dist/db/index.js");
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runProjectsCommand } = await import("../dist/cli/projects.js");
  const dir = temp(t);
  const directory = join(dir, "primary", "shards");
  const first = await openNodeDatabase({ directory });
  const routes = defineDatabaseService(first.api).api.v1;
  const route = (method) => routes.find((entry) => entry.path === "/maintenance/storage" && entry.method === method);
  const call = async (method, body) => { const answer = await route(method).handler({ service: first.api, params: {}, query: new URLSearchParams(), body, principal: undefined }); return answer.body; };
  const fetch = async (input, init) => new Response(JSON.stringify(await call(init?.method ?? "GET", init?.body ? JSON.parse(init.body) : undefined)), { status: 200, headers: { "content-type": "application/json" } });
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch });
  const cli = async (args) => {
    const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
    globalThis.fetch = fetch; console.log = (line) => lines.push(String(line));
    try { await runProjectsCommand([...args, "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
    return JSON.parse(lines.join("\n")).storage;
  };
  try {
    assert.deepEqual(await call("GET"), { engine: "sqlite", durability: "crash" });
    assert.deepEqual(await client.projects.setDatabaseStorage("p1", { durability: "power" }), { engine: "sqlite", durability: "crash", pending: "power" });
    assert.deepEqual(await cli(["storage", "p1"]), { engine: "sqlite", durability: "crash", pending: "power" });
    assert.match((await call("PUT", { durability: "sometimes" })).error, /crash or power/);
  } finally { await first.close(); }
  const second = await openNodeDatabase({ directory });
  try {
    assert.deepEqual(second.api.storageChoice.get(), { engine: "sqlite", durability: "power" }, "the next open uses the recorded choice");
    assert.deepEqual(second.api.context.storage, { engine: "sqlite", durability: "power" });
  } finally { await second.close(); }
});
