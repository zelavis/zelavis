import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStorageServiceRegistryStore, createSystemStoreServiceRegistryStore,
  createKeyValueServiceRegistryStore,
  createMemorySystemStore, zelavis,
} from "../dist/index.js";
import { mutateServiceRegistry, createMemoryServiceRegistryStore } from "../dist/platform/settings.js";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "zv-registry-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const add = (name) => (entries) => [...entries, { name, specifier: `file:///private/${name}.js` }];

// Force both callers to build their first changes from exactly the same revision.
async function race(left, right) {
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const calls = [0, 0];
  await Promise.all([left, right].map((store, index) => mutateServiceRegistry(store, async (entries) => {
    calls[index]++;
    if (calls[index] === 1) {
      if (++arrived === 2) release();
      await barrier;
    }
    return add(`writer-${index}`)(entries);
  })));
  assert.equal(calls.reduce((a, b) => a + b), 3, "loser must reapply intent to a fresh read");
  assert.deepEqual((await left.read()).map((e) => e.name).sort(), ["writer-0", "writer-1"]);
}

for (const adapter of ["memory", "local-files", "sqlite"]) {
  test(`${adapter}: concurrent independent mutations preserve both writers and reject stale snapshots`, async (t) => {
    let left, right;
    if (adapter === "memory") {
      const system = createMemorySystemStore();
      left = createSystemStoreServiceRegistryStore(system);
      right = createSystemStoreServiceRegistryStore(system);
    } else if (adapter === "local-files") {
      const root = directory(t);
      left = createFileStorageServiceRegistryStore(createLocalFileStorage(root), undefined, { scope: "process" });
      right = createFileStorageServiceRegistryStore(createLocalFileStorage(root), undefined, { scope: "process" });
    } else {
      const filename = join(directory(t), "system.sqlite");
      const a = createLocalSqliteSystemStore({ filename });
      const b = createLocalSqliteSystemStore({ filename });
      t.after(() => { a.close(); b.close(); });
      left = createSystemStoreServiceRegistryStore(a);
      right = createSystemStoreServiceRegistryStore(b);
    }
    const absent = await left.readSnapshot();
    assert.equal(absent.revision, null);
    await race(left, right);
    assert.equal(await left.compareAndSet(absent.revision, []), false);
    const stale = await left.readSnapshot();
    await mutateServiceRegistry(right, add("later"));
    assert.equal(await left.compareAndSet(stale.revision, []), false);
    assert.equal((await left.read()).length, 3);
  });
}

test("registry reads and updates old layouts without losing references or unknown fields", async (t) => {
  const storage = createLocalFileStorage(directory(t));
  const path = "zelavis/services.json";
  const old = { custom: { keep: true }, services: [{ name: "existing", specifier: "file:///retained/source", futureField: "retained" }] };
  await storage.put({ path, body: JSON.stringify(old) });
  const registry = createFileStorageServiceRegistryStore(storage, path, { scope: "process" });
  const initial = await registry.readSnapshot();
  assert.deepEqual(initial.entries, old.services);
  await mutateServiceRegistry(registry, add("new"));
  const persisted = JSON.parse(new TextDecoder().decode((await storage.get(path)).body));
  assert.deepEqual(persisted.custom, old.custom);
  assert.deepEqual(persisted.services[0], old.services[0]);
  await mutateServiceRegistry(registry, () => old.services);
  assert.notEqual((await registry.readSnapshot()).revision, initial.revision, "A-B-A must get a fresh revision");
  assert.equal(await registry.compareAndSet(initial.revision, []), false);
});

test("malformed and duplicate registries fail closed without modifying bytes", async (t) => {
  const storage = createLocalFileStorage(directory(t));
  const path = "registry.json";
  const registry = createFileStorageServiceRegistryStore(storage, path, { scope: "process" });
  for (const body of ['{"unexpected":[]}', '{"services":[{"name":"a"},{"name":"a"}]}', 'not json']) {
    await storage.put({ path, body });
    await assert.rejects(mutateServiceRegistry(registry, add("new")));
    assert.equal(new TextDecoder().decode((await storage.get(path)).body), body);
  }
});

test("bounded conflicts re-read eight times; uncertain writes never replay the mutation", async () => {
  let reads = 0, writes = 0, mutations = 0;
  const conflict = {
    readSnapshot: () => { reads++; return { entries: [], revision: `r${reads}` }; },
    compareAndSet: () => { writes++; return false; },
  };
  await assert.rejects(mutateServiceRegistry(conflict, (entries) => { mutations++; return add("a")(entries); }), /all 8 mutation attempts/);
  assert.deepEqual([reads, writes, mutations], [8, 8, 8]);
  const store = createMemoryServiceRegistryStore([]);
  let attempts = 0;
  const uncertain = { ...store, async compareAndSet(...args) {
    attempts++;
    await store.compareAndSet(...args);
    throw new Error("connection lost after commit");
  } };
  await assert.rejects(mutateServiceRegistry(uncertain, add("once")), /connection lost/);
  assert.equal(attempts, 1);
  assert.equal(store.read().length, 1);
});

test("stale file reads reach conditional PUT and cannot overwrite a winner", async (t) => {
  const base = createLocalFileStorage(directory(t));
  const path = "registry.json";
  const original = await base.put({ path, body: JSON.stringify({ services: [{ name: "original" }] }) });
  const stale = await base.get(path);
  const storage = { ...base, get: (key) => key === path ? stale : base.get(key) };
  const registry = createFileStorageServiceRegistryStore(storage, path, { scope: "process" });
  const winner = JSON.stringify({ services: [{ name: "winner" }], revision: "fresh" });
  await base.put({ path, body: winner, condition: { ifMatch: original.etag } });
  await assert.rejects(mutateServiceRegistry(registry, add("loser")), /all 8 mutation attempts/);
  assert.equal(new TextDecoder().decode((await base.get(path)).body), winner);
});

test("registry outage invalidates cached qualification; missing etags never imply absence", async (t) => {
  const base = createLocalFileStorage(directory(t));
  const path = "registry.json";
  let outage = false, missing = false, probes = 0;
  const storage = {
    ...base,
    async get(key) {
      if (key === path && outage) throw new Error("offline");
      const file = await base.get(key);
      return key === path && missing && file ? { ...file, etag: undefined } : file;
    },
    put(input) {
      if (input.path.startsWith("zelavis-probe/") && input.condition?.ifAbsent) probes++;
      return base.put(input);
    },
  };
  const registry = createFileStorageServiceRegistryStore(storage, path, { scope: "process" });
  await mutateServiceRegistry(registry, add("kept"));
  const before = probes;
  outage = true;
  await assert.rejects(mutateServiceRegistry(registry, add("lost")), /offline/);
  outage = false;
  await registry.read();
  assert.ok(probes > before);
  missing = true;
  await assert.rejects(mutateServiceRegistry(registry, add("lost")), /no etag/);
  missing = false;
  assert.deepEqual((await registry.read()).map((e) => e.name), ["kept"]);
});

test("plain key-value registry remains readable but refuses unsafe mutation", async () => {
  let writes = 0;
  const store = createKeyValueServiceRegistryStore({ get: () => JSON.stringify({ services: [{ name: "retained" }] }), set: () => { writes++; } });
  assert.equal((await store.read())[0].name, "retained");
  await assert.rejects(mutateServiceRegistry(store, add("new")), /no atomic conditional/);
  assert.equal(writes, 0);
});

for (const adapter of ["memory", "sqlite"]) {
  test(`${adapter}: atomic value guard rejects recreation during CAS even with a repeated timestamp`, async (t) => {
    const filename = join(directory(t), "system.sqlite");
    const store = adapter === "memory" ? createMemorySystemStore() : createLocalSqliteSystemStore({ filename });
    t.after(() => store.close?.());
    const original = await store.set("services", "registry", { revision: "old", services: [] });
    // A repeated timestamp is injected without relying on the wall clock.
    const newer = { revision: "new", services: [{ name: "winner" }] };
    if (adapter === "memory") {
      // Freezing time makes delete/recreate reuse the timestamp deterministically.
      t.mock.timers.enable({ apis: ["Date"], now: Date.parse(original.updatedAt) });
      await store.delete("services", "registry");
      await store.setIfAbsent("services", "registry", newer);
    } else {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(filename);
      db.prepare("UPDATE zelavis_system_records SET value_json = ? WHERE namespace = 'services' AND record_key = 'registry'").run(JSON.stringify(newer));
      db.close();
    }
    {
      assert.equal(await store.compareAndSet("services", "registry", original.updatedAt, { services: [] }, original.value), undefined);
      assert.deepEqual((await store.get("services", "registry")).value, newer);
    }
  });
}


test("HTTP, SDK and CLI mutations reapply intent and report conflict without activation", async (t) => {
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { updateRuntimeService } = await import("../dist/cli/services.js");
  const store = createMemoryServiceRegistryStore([
    { name: "unloaded", status: "available", specifier: "file:///preserve/unavailable.js", extra: "keep" },
    { name: "other", status: "available" },
  ]);
  let conflicts = 1, activated = 0;
  const racing = { ...store, async compareAndSet(revision, entries) {
    if (conflicts > 0) {
      conflicts--;
      await mutateServiceRegistry(store, (current) => current.map((e) => e.name === "other" ? { ...e, order: 7 } : e));
      return false;
    }
    return store.compareAndSet(revision, entries);
  } };
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    serviceRegistry: { store: racing },
    serviceActivation: { activate: () => { activated++; return { status: "active" }; } },
  });
  t.after(() => runtime.close());
  const principal = { id: "admin", type: "user", permissions: ["system.services.manage"] };
  const fetcher = (input, init) => runtime.fetch(new Request(input, init), { principal });
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  const response = await client.json("/runtime/services/unloaded", { method: "PATCH", body: JSON.stringify({ order: 3 }), headers: { "content-type": "application/json" } });
  assert.ok(response.services.some((e) => e.name === "unloaded" && e.order === 3));
  assert.equal(store.read().find((e) => e.name === "other").order, 7);
  assert.equal(store.read()[0].specifier, "file:///preserve/unavailable.js");
  assert.equal(store.read()[0].extra, "keep");
  const cli = await updateRuntimeService("unloaded", { order: 4 }, { url: "http://localhost/zelavis", fetch: fetcher });
  assert.ok(cli.services.some((e) => e.name === "unloaded" && e.order === 4));
  const before = activated;
  conflicts = Infinity;
  const failure = await fetcher("http://localhost/zelavis/api/v1/runtime/services/unloaded", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: 5 }),
  });
  assert.equal(failure.status, 409);
  assert.equal(activated, before);
  assert.equal(store.read()[0].order, 4);
});

test("registry startup does not reinterpret an outage as an empty installation", async () => {
  await assert.rejects(zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    serviceRegistry: { store: { read: () => { throw new Error("registry unavailable"); } } },
  }), /registry unavailable/);
});

test("SQLite registry mutations survive competing processes and reopen", async (t) => {
  const { spawn } = await import("node:child_process");
  const filename = join(directory(t), "system.sqlite");
  const initial = createLocalSqliteSystemStore({ filename });
  initial.close();
  const children = [0, 1].map((id) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createLocalSqliteSystemStore } from ${JSON.stringify(new URL("../dist/adapters/_sqlite-system-store.js", import.meta.url).href)};
      import { createSystemStoreServiceRegistryStore, mutateServiceRegistry } from ${JSON.stringify(new URL("../dist/platform/settings.js", import.meta.url).href)};
      const store = createLocalSqliteSystemStore({ filename: ${JSON.stringify(filename)} });
      const registry = createSystemStoreServiceRegistryStore(store);
      let first = true;
      let go;
      const barrier = new Promise((resolve) => { go = resolve; });
      process.once("message", go);
      await mutateServiceRegistry(registry, async (entries) => {
        if (first) { first = false; process.send("ready"); await barrier; }
        return [...entries, { name: "process-${id}", specifier: "file:///source-${id}" }];
      });
      store.close();
      process.disconnect();
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(new Error(errors)); });
    });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
    });
    return { child, ready, done };
  });
  await Promise.all(children.map((c) => c.ready));
  children.forEach((c) => c.child.send("go"));
  await Promise.all(children.map((c) => c.done));
  const reopened = createLocalSqliteSystemStore({ filename });
  t.after(() => reopened.close());
  const registry = createSystemStoreServiceRegistryStore(reopened);
  assert.deepEqual((await registry.read()).map((e) => e.name).sort(), ["process-0", "process-1"]);
});

test("Bun SQLite adapter enforces atomic value guards and independent registry CAS", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const available = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("Bun is not installed");
  assert.equal(available.status, 0, available.stderr);
  const filename = join(directory(t), "bun.sqlite");
  const result = spawnSync("bun", ["--eval", `
    import assert from "node:assert/strict";
    import { Database } from "bun:sqlite";
    import { createBunSqliteSystemStore } from ${JSON.stringify(new URL("../dist/adapters/_bun-sqlite-system-store.js", import.meta.url).href)};
    import { createSystemStoreServiceRegistryStore, mutateServiceRegistry } from ${JSON.stringify(new URL("../dist/platform/settings.js", import.meta.url).href)};
    const filename = ${JSON.stringify(filename)};
    const a = await createBunSqliteSystemStore({ filename });
    const b = await createBunSqliteSystemStore({ filename });
    const left = createSystemStoreServiceRegistryStore(a);
    const right = createSystemStoreServiceRegistryStore(b);
    await Promise.all([mutateServiceRegistry(left, (entries) => [...entries, {name: "a"}]), mutateServiceRegistry(right, (entries) => [...entries, {name: "b"}])]);
    assert.deepEqual((await left.read()).map((e) => e.name).sort(), ["a", "b"]);
    const observed = a.get("services", "registry");
    const changed = { revision: "replacement", services: [{name: "new"}] };
    const db = new Database(filename);
    db.query("UPDATE zelavis_system_records SET value_json = ? WHERE namespace = 'services'").run(JSON.stringify(changed));
    assert.equal(a.compareAndSet("services", "registry", observed.updatedAt, {services: []}, observed.value), undefined);
    assert.deepEqual(b.get("services", "registry").value, changed);
    db.close(); a.close(); b.close();
  `], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});
