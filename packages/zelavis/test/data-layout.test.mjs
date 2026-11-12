import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { commitDataSwap, dataFormatOnDisk, settleDataSwap, swapInMigratedData, undoDataSwap } from "../dist/adapters/_node-data-layout.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-data-layout-"));
  const paths = { zelavis: join(root, ".zelavis") };
  await mkdir(join(paths.zelavis, "data", "primary", "shards"), { recursive: true });
  await writeFile(join(paths.zelavis, "data", "primary", "shards", "old.sqlite"), "format two");
  const migrated = join(root, "migrated-shards");
  await mkdir(migrated);
  await writeFile(join(migrated, "new.sqlite"), "format four");
  return { root, paths, migrated };
}
const run = (effect) => Effect.runPromise(effect);
const names = async (paths) => (await readdir(paths.zelavis)).sort();
const shard = (dir, name) => readFile(join(dir, name), "utf8");

test("the format on disk is the recorded one, else the locked engine's", async () => {
  const { root, paths, migrated } = await project();
  try {
    assert.equal(await run(dataFormatOnDisk(paths, 2)), 2);
    await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1" }));
    assert.equal(await run(dataFormatOnDisk(paths, 2)), 4, "a swap records the layout it put in place");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a swap puts the migrated shards in place and keeps the old data beside them", async () => {
  const { root, paths, migrated } = await project();
  try {
    const { retained } = await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1" }));
    assert.equal(retained, "data.format-2-s1");
    assert.equal(await shard(join(paths.zelavis, "data", "primary", "shards"), "new.sqlite"), "format four");
    assert.equal(await shard(join(paths.zelavis, retained, "primary", "shards"), "old.sqlite"), "format two", "the old data is kept, not removed");
    await assert.rejects(run(swapInMigratedData(paths, { migratedShards: migrated, from: 4, to: 5, stamp: "s2" })), /already recorded/, "a second swap waits for the first to be settled");
    await run(commitDataSwap(paths));
    assert.ok(!(await names(paths)).includes("data-migration.json"), "committing ends the journal and keeps the retained data");
    assert.ok((await names(paths)).includes(retained));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an undone swap returns the old data, sets the migrated data aside and records the old layout", async () => {
  const { root, paths, migrated } = await project();
  try {
    await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1" }));
    assert.equal(await run(undoDataSwap(paths, "u1")), true);
    assert.equal(await shard(join(paths.zelavis, "data", "primary", "shards"), "old.sqlite"), "format two");
    assert.equal(await shard(join(paths.zelavis, "data.discarded-u1", "primary", "shards"), "new.sqlite"), "format four", "migrated data is set aside, never removed");
    assert.equal(await run(dataFormatOnDisk(paths, 4)), 2, "the layout record follows the data");
    assert.equal(await run(undoDataSwap(paths, "u2")), false, "nothing to undo once settled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a crash is settled from the files alone", async () => {
  // After the swap, before the upgrade that needed it was recorded: the locked engine still writes the old layout, so it is undone.
  const a = await project();
  try {
    await run(swapInMigratedData(a.paths, { migratedShards: a.migrated, from: 2, to: 4, stamp: "s1" }));
    assert.equal(await run(settleDataSwap(a.paths, 2, "c1")), "undone");
    assert.equal(await shard(join(a.paths.zelavis, "data", "primary", "shards"), "old.sqlite"), "format two");
  } finally { await rm(a.root, { recursive: true, force: true }); }

  // The upgrade was recorded (the lock names an engine that writes the new layout): the swap stands.
  const b = await project();
  try {
    await run(swapInMigratedData(b.paths, { migratedShards: b.migrated, from: 2, to: 4, stamp: "s1" }));
    assert.equal(await run(settleDataSwap(b.paths, 4, "c2")), "committed");
    assert.equal(await shard(join(b.paths.zelavis, "data", "primary", "shards"), "new.sqlite"), "format four");
  } finally { await rm(b.root, { recursive: true, force: true }); }

  // Interrupted between moving the old data aside and putting the new in place: only the old data exists, and it comes back.
  const c = await project();
  try {
    await rename(join(c.paths.zelavis, "data"), join(c.paths.zelavis, "data.format-2-s1"));
    await writeFile(join(c.paths.zelavis, "data-migration.json"), JSON.stringify({ state: "swapping", from: 2, to: 4, retained: "data.format-2-s1", discarded: [] }));
    assert.equal(await run(settleDataSwap(c.paths, 2, "c3")), "undone");
    assert.equal(await shard(join(c.paths.zelavis, "data", "primary", "shards"), "old.sqlite"), "format two");
    assert.equal(await run(settleDataSwap(c.paths, 2, "c4")), "none");
  } finally { await rm(c.root, { recursive: true, force: true }); }
});

test("an undo that cannot find the data it set aside refuses instead of guessing", async () => {
  const { root, paths, migrated } = await project();
  try {
    await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1" }));
    await rm(join(paths.zelavis, "data.format-2-s1"), { recursive: true, force: true });
    await assert.rejects(run(undoDataSwap(paths, "u1")), /missing/);
    assert.equal(await shard(join(paths.zelavis, "data", "primary", "shards"), "new.sqlite"), "format four", "the current data is untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a host that will not start on the migrated data gets the old data and its own engine back, and the failure is the one reported", async () => {
  const { startOnSwappedData } = await import("../dist/adapters/_node-data-layout.js");
  const { root, paths, migrated } = await project();
  try {
    await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1", engine: "1.0.0" }));
    const seen = [];
    const failing = Effect.sync(() => { seen.push("start"); }).pipe(Effect.andThen(Effect.fail(new Error("the bound host would not start on the new engine"))));
    const restart = Effect.sync(() => { seen.push(["restart", "data back"]); });
    await assert.rejects(run(startOnSwappedData(paths, "u1", failing, restart)), /would not start/);
    assert.deepEqual(seen.map((step) => (Array.isArray(step) ? step[0] : step)), ["start", "restart"], "started once on the new data, then again after the undo");
    assert.equal(await shard(join(paths.zelavis, "data", "primary", "shards"), "old.sqlite"), "format two", "the old data is back");
    assert.deepEqual(await run(dataFormatOnDisk(paths, 4)), 2);
    const layout = JSON.parse(await readFile(join(paths.zelavis, "data-layout.json"), "utf8"));
    assert.deepEqual(layout, { format: 2, engine: "1.0.0" }, "and it names the engine that wrote it, which a restart must use");
    assert.ok((await names(paths)).includes("data.discarded-u1"), "the migrated data is set aside, not deleted");

    // A host that starts leaves the swap alone.
    const ok = await project();
    try {
      await run(swapInMigratedData(ok.paths, { migratedShards: ok.migrated, from: 2, to: 4, stamp: "s2" }));
      await run(startOnSwappedData(ok.paths, "u2", Effect.void, Effect.sync(() => { throw new Error("must not restart"); })));
      assert.equal(await shard(join(ok.paths.zelavis, "data", "primary", "shards"), "new.sqlite"), "format four");
    } finally { await rm(ok.root, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained data is listed with its size and removed only by an exact name, never while a swap is unsettled", async () => {
  const { listRetainedData, removeRetainedData } = await import("../dist/adapters/_node-data-layout.js");
  const { root, paths, migrated } = await project();
  try {
    const { retained } = await run(swapInMigratedData(paths, { migratedShards: migrated, from: 2, to: 4, stamp: "s1" }));
    await assert.rejects(run(removeRetainedData(paths, retained)), /unsettled/, "the journal may still need it to undo");
    await run(commitDataSwap(paths));
    const listed = await run(listRetainedData(paths));
    assert.deepEqual(listed.map((entry) => [entry.name, entry.kind]), [[retained, "replaced-by-migration"]]);
    assert.equal(listed[0].bytes, "format two".length, "the size is what the kept shards hold");

    // Only such a directory, by its exact name.
    for (const bad of ["data", "../x", `${retained}/primary`, "data.format-2-", "migration-x", "data-layout.json"]) {
      await assert.rejects(run(removeRetainedData(paths, bad)), /not retained data/, bad);
    }
    await assert.rejects(run(removeRetainedData(paths, "data.format-9-nothere")), /does not exist/);
    assert.equal((await readdir(join(paths.zelavis, "data", "primary", "shards"))).length > 0, true, "the live data is untouched");

    await run(removeRetainedData(paths, retained));
    assert.deepEqual(await run(listRetainedData(paths)), []);
    assert.equal(await shard(join(paths.zelavis, "data", "primary", "shards"), "new.sqlite"), "format four", "removing retained data never touches the live data");
  } finally { await rm(root, { recursive: true, force: true }); }
});
