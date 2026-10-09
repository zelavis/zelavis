import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { relocateDirectories } from "../dist/adapters/_recipe-relocation.js";
import { parseRecipeManifest } from "zelavis/recipe";

const run = (input) => Effect.runPromise(relocateDirectories(input));
const scratch = async (t) => { const root = await mkdtemp(join(tmpdir(), "zv-reloc-")); t.after(() => rm(root, { recursive: true, force: true })); return root; };

test("a directory moves to the place the recipe names, with its contents", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "old"), { recursive: true });
  await writeFile(join(root, "old", "data"), "x");
  const result = await run({ root, layout: { db: "old" }, directories: [{ name: "db", wanted: "deeper/new" }] });
  assert.deepEqual(result.layout, { db: "deeper/new" });
  assert.deepEqual(result.moved, ["db"]);
  assert.equal(await readFile(join(root, "deeper", "new", "data"), "utf8"), "x");
  assert.equal(existsSync(join(root, "old")), false);
});

test("a directory already where the recipe wants it is left alone, and a crash after the rename is finished by the next call", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "new"), { recursive: true });
  await writeFile(join(root, "new", "data"), "x");
  // The map still says "old": the rename happened and the map was not yet written.
  const result = await run({ root, layout: { db: "old" }, directories: [{ name: "db", wanted: "new" }] });
  assert.deepEqual(result.layout, { db: "new" });
  assert.equal(await readFile(join(root, "new", "data"), "utf8"), "x");
  assert.deepEqual((await run({ root, layout: result.layout, directories: [{ name: "db", wanted: "new" }] })).moved, []);
});

test("data is never clobbered: a destination holding something keeps the directory where it was", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "old"), { recursive: true });
  await mkdir(join(root, "new"), { recursive: true });
  await writeFile(join(root, "old", "data"), "old");
  await writeFile(join(root, "new", "other"), "other");
  const result = await run({ root, layout: { db: "old" }, directories: [{ name: "db", wanted: "new" }] });
  assert.deepEqual(result.layout, { db: "old" });
  assert.equal(result.kept.length, 1);
  assert.equal(await readFile(join(root, "old", "data"), "utf8"), "old");
  assert.equal(await readFile(join(root, "new", "other"), "utf8"), "other");
});

test("an empty directory the install made in the destination is replaced by the data", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "old"), { recursive: true });
  await mkdir(join(root, "new"), { recursive: true });
  await writeFile(join(root, "old", "data"), "old");
  const result = await run({ root, layout: { db: "old" }, directories: [{ name: "db", wanted: "new" }] });
  assert.deepEqual(result.layout, { db: "new" });
  assert.equal(await readFile(join(root, "new", "data"), "utf8"), "old");
});

test("a directory neither place has yet simply takes the new name", async (t) => {
  const root = await scratch(t);
  const result = await run({ root, layout: { db: "old" }, directories: [{ name: "db", wanted: "new" }] });
  assert.deepEqual(result.layout, { db: "new" });
});

test("a manifest's directories are unique, relative and never nested", () => {
  const base = { contract: 1, methods: [{ id: "native", driver: "js", entry: "./dist/r.mjs", requires: [] }], software: [{ version: "1.0", archive: "https://example.com/a.tgz", sha256: "a".repeat(64), maxBytes: 10 }], ports: [] };
  const parse = (directories) => parseRecipeManifest({ ...base, directories });
  assert.deepEqual(parse([{ name: "db", path: "data/db" }]).directories, [{ name: "db", path: "data/db" }]);
  for (const bad of [
    [{ name: "db", path: "../escape" }], [{ name: "db", path: "/abs" }], [{ name: "db", path: "a" }, { name: "db", path: "b" }],
    [{ name: "a", path: "x" }, { name: "b", path: "x" }], [{ name: "a", path: "x" }, { name: "b", path: "x/y" }],
  ]) assert.throws(() => parse(bad), undefined, JSON.stringify(bad));
});
