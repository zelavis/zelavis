import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";

for (const engine of ["memory", "sqlite"]) test(`${engine} backend enumeration and pages isolate namespaces without changing records`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "zv-store-inspect-"));
  const store = engine === "memory" ? createMemorySystemStore() : createLocalSqliteSystemStore({ filename: join(directory, "store.sqlite") });
  t.after(async () => { await store.close?.(); await rm(directory, { recursive: true, force: true }); });
  for (const key of ["c", "a", "b"]) await store.set("one", key, { key });
  await store.set("two", "a", { other: true });
  assert.deepEqual(await store.namespaces(), [{ namespace: "one", recordCount: 3 }, { namespace: "two", recordCount: 1 }]);
  const page = await store.page("one", { limit: 2 });
  assert.deepEqual(page.records.map(record => record.key), ["a", "b"]);
  assert.equal(page.next, "b");
  const next = await store.page("one", { limit: 2, after: page.next });
  assert.deepEqual(next.records.map(record => record.key), ["c"]);
  assert.equal(next.next, undefined);
  assert.equal((await store.list("one")).length, 3);
});

test("Platform backend inspection has HTTP, SDK and CLI parity, redacts authority and denies Project grants", async t => {
  const store = createMemorySystemStore();
  const zv = await zelavis({ systemStore: store });
  t.after(() => zv.close());
  await store.set("test", "a", { name: "visible", nested: { apiKey: "sensitive-value" } });
  await store.set("test", "b", { count: 2 });
  await store.set("platform", "master-secret", "sensitive-master");
  await store.set("zelavis.platform.auth", "session:example", { token: "sensitive-session" });
  const owner = { principal: { id: "owner", type: "user", permissions: ["server.database.inspect"] } };
  const fetcher = (url, init) => zv.fetch(new Request(url, init), owner);
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  const response = await fetcher("http://localhost/zelavis/api/v1/runtime/system-store/namespaces/test/records?limit=1");
  assert.equal(response.status, 200);
  const http = await response.json();
  assert.deepEqual(await client.runtime.systemStore.records("test", { limit: 1 }), http);
  assert.equal(http.records[0].value.nested.apiKey, "[redacted]");
  assert.equal(http.next, "a");
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const output = [];
  try {
    globalThis.fetch = fetcher; console.log = value => output.push(value);
    await runCli(["system-store", "records", "test", "--limit", "1", "--json", "--url", "http://localhost/zelavis"]);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.deepEqual(JSON.parse(output.join("\n")), http);
  assert.deepEqual((await client.runtime.systemStore.records("test", { after: "a" })).records.map(row => row.key), ["b"]);
  assert.equal((await client.runtime.systemStore.records("platform")).records.find(row => row.key === "master-secret").value, "[redacted]");
  assert.equal((await client.runtime.systemStore.records("zelavis.platform.auth")).records.find(row => row.key === "session:example").value, "[redacted]");
  assert.equal((await store.get("test", "a")).value.nested.apiKey, "sensitive-value");
  assert.ok((await client.runtime.systemStore.namespaces()).some(row => row.namespace === "test" && row.recordCount === 2));
  for (const limit of ["0", "201", "NaN", "1.5"]) assert.equal((await fetcher(`http://localhost/zelavis/api/v1/runtime/system-store/namespaces/test/records?limit=${limit}`)).status, 400);
  for (const principal of [
    { id: "anon", type: "anonymous" },
    { id: "project-admin", type: "user", grants: [{ permission: "server.database.inspect", scope: { type: "project", projectId: "child" } }] },
  ]) {
    const denied = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/system-store/namespaces"), { principal });
    assert.ok([401, 403].includes(denied.status));
  }
  assert.equal((await fetcher("http://localhost/zelavis/api/v1/runtime/system-store/namespaces/test/records", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 404);
});
