// Taking over a Project laid out by an earlier version of a recipe: folders are renamed and a few
// values carried over, nothing of the application is read or rewritten, and a failure goes back.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { parseRecipeManifest } from "zelavis/recipe";
import { adoptionPending, applyAdoption, commitAdoption, detectAdoption, revertAdoption } from "../dist/adapters/_recipe-adoption.js";

const ADOPT = {
  state: "legacy.json",
  move: { site: "web/site", data: "db" },
  ports: { web: "httpPort", db: "databasePort" },
  secrets: { "db-password": "password" },
  socketId: "socketId",
  marks: ["db/.initialized"],
  discard: ["generated.conf", "tmp"],
};

async function legacy(t, state = { httpPort: 18080, databasePort: 13306, password: "legacy-password-1", socketId: "abc123" }) {
  const base = await mkdtemp(join(tmpdir(), "zv-adopt-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const zelavis = join(base, ".zelavis");
  const root = join(base, "app");
  const secrets = join(zelavis, "secrets");
  await mkdir(join(zelavis, "site", "wp-content"), { recursive: true });
  await mkdir(join(zelavis, "data", "mysql"), { recursive: true });
  await mkdir(join(zelavis, "tmp"), { recursive: true });
  await writeFile(join(zelavis, "site", "index.php"), "<?php // the site");
  await writeFile(join(zelavis, "site", "wp-content", "upload.jpg"), "image bytes");
  await writeFile(join(zelavis, "data", "mysql", "tables.ibd"), "database bytes");
  await writeFile(join(zelavis, "generated.conf"), "regenerated later");
  await writeFile(join(zelavis, "legacy.json"), JSON.stringify(state));
  const adoption = parseRecipeManifest({
    contract: 1, methods: [{ id: "native", driver: "js", entry: "./r.mjs", requires: [] }],
    software: [{ version: "1.0", archive: "https://example.com/a.tar.gz", sha256: "a".repeat(64), maxBytes: 10 }],
    ports: [{ name: "web", protocol: "http" }, { name: "db", protocol: "tcp" }], adopt: [ADOPT],
  }).adopt[0];
  return { base, zelavis, root, secrets, locations: { zelavis, root, secrets }, adoption };
}
const run = (effect) => Effect.runPromise(effect);
const failure = async (effect) => {
  try { await run(effect); } catch (error) { return error; }
  assert.fail("expected a failure");
};
/** Every file below a directory with its bytes, to compare a tree before and after. */
function snapshot(directory, prefix = "") {
  const entries = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) Object.assign(entries, snapshot(path, `${prefix}${name}/`));
    else entries[`${prefix}${name}`] = readFileSync(path, "utf8");
  }
  return entries;
}

test("an earlier layout is recognized by its state file", async (t) => {
  const { locations, adoption, zelavis } = await legacy(t);
  assert.equal((await run(detectAdoption([adoption], locations)))?.state, "legacy.json");
  assert.equal(await run(detectAdoption(undefined, locations)), undefined);
  await rm(join(zelavis, "legacy.json"));
  assert.equal(await run(detectAdoption([adoption], locations)), undefined);
});

test("folders are renamed, not copied or rewritten; ports, password and socket identity are carried over", async (t) => {
  const { locations, adoption, zelavis, root, secrets } = await legacy(t);
  const before = snapshot(join(zelavis, "site"));
  const values = await run(applyAdoption(adoption, locations));
  assert.deepEqual(values, { ports: { web: 18080, db: 13306 }, socketId: "abc123" });
  assert.deepEqual(snapshot(join(root, "web", "site")), before, "the site's files are byte for byte what they were");
  assert.equal(readFileSync(join(root, "db", "mysql", "tables.ibd"), "utf8"), "database bytes");
  assert.equal(existsSync(join(zelavis, "site")), false);
  assert.equal(existsSync(join(zelavis, "data")), false);
  assert.equal(readFileSync(join(secrets, "db-password"), "utf8"), "legacy-password-1");
  assert.equal(statSync(join(secrets, "db-password")).mode & 0o077, 0);
  assert.ok(existsSync(join(root, "db", ".initialized")), "the completion marker exists");
  assert.equal(existsSync(join(zelavis, "legacy.json")), true, "the earlier state stays until commit, so there is a way back");
  assert.equal(await run(adoptionPending(locations)), true);
});

test("an interrupted adoption resumes: each step is done unless it already is", async (t) => {
  const { locations, adoption, zelavis, root } = await legacy(t);
  // As if the process died after the first rename.
  await mkdir(join(root, "web"), { recursive: true });
  await import("node:fs/promises").then(({ rename }) => rename(join(zelavis, "site"), join(root, "web", "site")));
  const values = await run(applyAdoption(adoption, locations));
  assert.equal(values.ports.web, 18080);
  assert.equal(readFileSync(join(root, "web", "site", "wp-content", "upload.jpg"), "utf8"), "image bytes");
  assert.equal(readFileSync(join(root, "db", "mysql", "tables.ibd"), "utf8"), "database bytes");
  await run(applyAdoption(adoption, locations));
});

test("revert puts everything back exactly and removes what the adoption made", async (t) => {
  const { locations, adoption, zelavis, root, secrets } = await legacy(t);
  const before = snapshot(zelavis);
  await run(applyAdoption(adoption, locations));
  await mkdir(join(root, "generated-later"), { recursive: true });
  await writeFile(join(root, "generated-later", "nginx.conf"), "made by the install phase");
  await run(revertAdoption(locations));
  assert.deepEqual(snapshot(zelavis), before, "the earlier layout is byte for byte as it was");
  assert.equal(existsSync(root), false, "a root the adoption created is removed with what was generated in it");
  assert.equal(existsSync(join(secrets, "db-password")), false);
  assert.equal(await run(adoptionPending(locations)), false);
  await run(revertAdoption(locations));
});

test("commit discards the earlier state and generated leftovers, and closes the way back", async (t) => {
  const { locations, adoption, zelavis, root } = await legacy(t);
  await run(applyAdoption(adoption, locations));
  await run(commitAdoption(locations));
  assert.equal(existsSync(join(zelavis, "legacy.json")), false);
  assert.equal(existsSync(join(zelavis, "generated.conf")), false);
  assert.equal(existsSync(join(zelavis, "tmp")), false);
  assert.equal(readFileSync(join(root, "web", "site", "index.php"), "utf8"), "<?php // the site", "the application is untouched");
  assert.equal(await run(adoptionPending(locations)), false);
  assert.equal(await run(detectAdoption([adoption], locations)), undefined, "it is not adopted twice");
  await run(commitAdoption(locations));
});

test("a folder in both places, or in neither, or a link, stops it with nothing further moved", async (t) => {
  const both = await legacy(t);
  await mkdir(join(both.root, "web", "site"), { recursive: true });
  assert.match((await failure(applyAdoption(both.adoption, both.locations))).message, /exists both where it was and where it goes/);
  assert.equal(existsSync(join(both.zelavis, "data")), true, "the second folder was not touched");

  const missing = await legacy(t);
  await rm(join(missing.zelavis, "data"), { recursive: true });
  assert.match((await failure(applyAdoption(missing.adoption, missing.locations))).message, /is not there/);

  const linked = await legacy(t);
  await rm(join(linked.zelavis, "site"), { recursive: true });
  await mkdir(join(linked.base, "elsewhere"));
  await symlink(join(linked.base, "elsewhere"), join(linked.zelavis, "site"));
  assert.match((await failure(applyAdoption(linked.adoption, linked.locations))).message, /symbolic link/);
  await run(revertAdoption(linked.locations));
  assert.equal(existsSync(join(linked.zelavis, "site")), true);
});

test("values that are not what they should be are refused before anything moves", async (t) => {
  for (const [state, pattern] of [
    [{ httpPort: "80", databasePort: 13306, password: "legacy-password-1", socketId: "a" }, /no usable port for "web"/],
    [{ httpPort: 80, databasePort: 13306, password: "legacy-password-1", socketId: "a" }, /no usable port for "web"/],
    [{ httpPort: 18080, databasePort: 18080, password: "legacy-password-1", socketId: "a" }, /same number/],
    [{ httpPort: 18080, databasePort: 13306, password: "short", socketId: "a" }, /no usable value for the secret/],
    [{ httpPort: 18080, databasePort: 13306, password: "legacy-password-1", socketId: "../x" }, /socket identity/],
  ]) {
    const subject = await legacy(t, state);
    assert.match((await failure(applyAdoption(subject.adoption, subject.locations))).message, pattern);
    assert.equal(existsSync(join(subject.zelavis, "site")), true, "nothing was moved");
    assert.equal(await run(adoptionPending(subject.locations)), false, "and no journal was started");
  }
  const text = await legacy(t);
  await writeFile(join(text.zelavis, "legacy.json"), "not json");
  assert.match((await failure(applyAdoption(text.adoption, text.locations))).message, /not valid JSON/);
  await writeFile(join(text.zelavis, "legacy.json"), "[1]");
  assert.match((await failure(applyAdoption(text.adoption, text.locations))).message, /not valid JSON/);
});

test("a different secret already stored is never overwritten", async (t) => {
  const { locations, adoption, secrets } = await legacy(t);
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "db-password"), "something-else-entirely", { mode: 0o600 });
  await failure(applyAdoption(adoption, locations));
  assert.equal(readFileSync(join(secrets, "db-password"), "utf8"), "something-else-entirely");
});

test("the Project's own entries can never be claimed by an earlier layout", async () => {
  for (const state of ["recipe", "secrets", "recipe-state.json", "adoption.json"]) {
    const reserved = parseRecipeManifest({
      contract: 1, methods: [{ id: "native", driver: "js", entry: "./r.mjs", requires: [] }],
      software: [{ version: "1.0", archive: "https://example.com/a.tar.gz", sha256: "a".repeat(64), maxBytes: 10 }],
      ports: [], adopt: [{ state: "x.json", move: { [state]: "taken" } }],
    }).adopt[0];
    await assert.rejects(run(applyAdoption(reserved, { zelavis: "/nonexistent", root: "/nonexistent/app", secrets: "/nonexistent/s" })), /belongs to the Project/);
  }
});

test("adoption in a manifest is validated: paths stay relative, ports must be declared, nothing repeats", () => {
  const base = () => ({
    contract: 1, methods: [{ id: "native", driver: "js", entry: "./r.mjs", requires: [] }],
    software: [{ version: "1.0", archive: "https://example.com/a.tar.gz", sha256: "a".repeat(64), maxBytes: 10 }],
    ports: [{ name: "web", protocol: "http" }],
  });
  const ok = { state: "s.json", move: { a: "b" } };
  assert.doesNotThrow(() => parseRecipeManifest({ ...base(), adopt: [ok] }));
  for (const bad of [
    { ...ok, state: "../s.json" }, { ...ok, state: "/etc/passwd" }, { ...ok, move: { "../a": "b" } }, { ...ok, move: { a: "/b" } },
    { ...ok, move: {} }, { ...ok, move: { a: "x", b: "x" } }, { ...ok, ports: { database: "p" } }, { ...ok, ports: { web: "not a key" } },
    { ...ok, extra: true }, { ...ok, discard: ["../x"] }, { ...ok, marks: Array.from({ length: 17 }, (_, i) => `m${i}`) },
  ]) {
    assert.throws(() => parseRecipeManifest({ ...base(), adopt: [bad] }), (error) => error._tag === "InvalidRecipeManifest", JSON.stringify(bad));
  }
  assert.throws(() => parseRecipeManifest({ ...base(), adopt: Array.from({ length: 5 }, () => ok) }), (error) => error._tag === "InvalidRecipeManifest");
});
