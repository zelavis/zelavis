import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { openTemporaryDatabase } from "./_database.mjs";

const bundle = (schemas) => ({ format: "zelavis.logical-schema", version: 1, schemas });
const field = (_tag, options = {}) => ({ _tag, label: _tag, required: true, ...options });
const schema = (collection, version, fields = [], active = false) => ({ collection, version, fields, active });
const refusal = async (run, pattern) => {
  await assert.rejects(run, error => {
    assert.equal(error._tag, "SchemaTransferRefused");
    assert.match(error.reason, pattern);
    return true;
  });
};

test("logical schema import preflights everything, defaults to dry run, activates explicitly and round trips across tenants", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const source = api.forTenant("source"), destination = api.forTenant("destination");
  await source.schemas.save({ collection: "posts", version: 1, fields: [{ name: "title", field: field("TextField") }] });
  await source.schemas.save({ collection: "posts", version: 2, activate: false, fields: [{ name: "title", field: field("LongTextField") }] });
  const exported = await source.schemas.export();
  assert.deepEqual(Object.keys(exported).sort(), ["format", "schemas", "version"]);
  assert.deepEqual(exported.schemas.map(s => [s.version, s.active]), [[1, true], [2, false]]);
  const preflight = await destination.schemas.import({ bundle: exported });
  assert.equal(preflight.dryRun, true);
  assert.deepEqual(await destination.schemas.listCollections(), []);
  const saved = await destination.schemas.import({ bundle: exported, dryRun: false });
  assert.equal(saved.complete, true);
  assert.equal(await destination.schemas.getActive("posts"), undefined);
  const activated = await destination.schemas.import({ bundle: exported, dryRun: false, activate: true });
  assert.equal(activated.activations[0].status, "activated");
  assert.ok(activated.versions.every(item => item.action === "reuse"));
  assert.deepEqual(await destination.schemas.export(), exported);
  assert.deepEqual(await source.schemas.export({ collections: [] }), bundle([]));
  assert.equal((await source.schemas.types()).source, (await destination.schemas.types()).source);
});

test("a later immutable conflict prevents earlier versions from being imported, and member order is immaterial", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("acme");
  const fields = [{ name: "title", field: field("TextField") }];
  await tenant.schemas.save({ collection: "z", version: 1, fields, activate: false });
  await refusal(() => tenant.schemas.import({ dryRun: false, bundle: bundle([schema("a", 1), schema("z", 1, [])]) }), /immutable schema conflict/);
  assert.deepEqual(await tenant.schemas.listVersions("a"), []);
  const reordered = [{ field: { required: true, label: "TextField", _tag: "TextField" }, name: "title" }];
  const answer = await tenant.schemas.import({ dryRun: false, bundle: bundle([schema("z", 1, reordered)]) });
  assert.equal(answer.versions[0].action, "reuse");
});

test("concurrent imports cannot overwrite an immutable version", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("race");
  const results = await Promise.allSettled(["TextField", "BooleanField"].map(tag => tenant.schemas.import({
    dryRun: false, bundle: bundle([schema("posts", 1, [{ name: "value", field: field(tag) }])]),
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason._tag, "SchemaTransferRefused");
  const versions = await tenant.schemas.listVersions("posts");
  assert.equal(versions.length, 1);
  const winner = results.findIndex(result => result.status === "fulfilled");
  assert.equal(versions[0].fields[0].field._tag, ["TextField", "BooleanField"][winner]);
});

test("invalid, duplicate, deeply nested and oversized schemas are refused before writes", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("invalid");
  let nested = [];
  for (let i = 0; i < 18; i++) nested = [{ name: "items", field: field("RepeaterField", { fields: nested }) }];
  const bad = [
    [{ format: "sql", version: 1, schemas: [] }, /logical-schema/],
    [bundle([schema("posts", 0)]), /positive safe integer/],
    [bundle([schema("posts", 1), schema("posts", 1)]), /duplicate/],
    [bundle([schema("posts", 1, [], true), schema("posts", 2, [], true)]), /multiple active/],
    [bundle([schema("posts", 1, [{ name: "a", field: field("TextField") }, { name: "a", field: field("BooleanField") }])]), /unique/],
    [bundle([schema("posts", 1, nested)]), /nesting depth/],
    [bundle([schema("posts", 1, [{ name: "text", field: field("TextField", { pattern: "[" }) }])]), /regular expression/i],
    [bundle([schema("posts", 1, [{ name: "vector", field: field("VectorField", { dimension: 1.5 }) }])]), /vector dimension/],
    [bundle([schema("posts", 1, [{ name: "large", field: field("TextField", { description: "x".repeat(2 * 1024 * 1024) }) }])]), /2 MiB/],
  ];
  for (const [value, pattern] of bad) await refusal(() => tenant.schemas.import({ bundle: value, dryRun: false }), pattern);
  assert.deepEqual(await tenant.schemas.listCollections(), []);
});

test("activation refusals retain imported versions and the prior active schema, and can be retried", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("activation");
  await tenant.documents.createCollection({ name: "posts" });
  await tenant.documents.insert({ collection: "posts", id: "a", data: { vector: "text" } });
  await tenant.schemas.save({ collection: "posts", version: 1, fields: [{ name: "vector", field: field("JsonField") }] });
  const input = { dryRun: false, activate: true, bundle: bundle([schema("posts", 2, [{ name: "vector", field: field("VectorField", { dimension: 2, metric: "cosine", model: "m", modelVersion: "1" }) }], true)]) };
  const result = await tenant.schemas.import(input);
  assert.equal(result.complete, false);
  assert.equal(result.activations[0].status, "refused");
  assert.equal((await tenant.schemas.getActive("posts")).version, 1);
  assert.equal((await tenant.schemas.getVersion("posts", 2)).active, false);
  await tenant.documents.update({ collection: "posts", id: "a", data: { vector: [1, 0] } });
  assert.equal((await tenant.schemas.import(input)).complete, true);
  assert.equal((await tenant.schemas.getActive("posts")).version, 2);
});

test("generated standalone types preserve optionality, choices, references, recursive fields and every version", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const tenant = api.forTenant("types");
  const fields = [
    { name: 'title"\n', field: field("TextField") },
    { name: "status", field: field("SelectField", { options: ["draft", 'pub"lished'] }) },
    { name: "tags", field: field("MultiSelectField", { required: false, options: ["a", "b"] }) },
    { name: "author", field: field("ReferenceField", { collection: "people" }) },
    { name: "file", field: field("ImageField", { required: false }) },
    { name: "json", field: field("JsonField", { required: false }) },
    { name: "location", field: field("GeometryField", { required: false, coordinates: "wgs84", resolution: 7 }) },
    { name: "vector", field: field("VectorField", { required: false, dimension: 2, metric: "cosine", model: "m", modelVersion: "1" }) },
    { name: "rows", field: field("RepeaterField", { fields: [{ name: "score", field: field("NumberField") }] }) },
  ];
  // A quote is legal in a name and must not inject source. Newlines are rejected.
  fields[0].name = 'title"';
  await tenant.schemas.save({ collection: "posts", version: 1, fields });
  await tenant.schemas.save({ collection: "posts", version: 2, fields: [], activate: false });
  const generated = await tenant.schemas.types();
  assert.equal(generated.filename, "zelavis-schema.d.ts");
  assert.doesNotMatch(generated.source, /import\s/);
  assert.match(generated.source, /"posts@2"/);
  const dir = mkdtempSync(join(tmpdir(), "zv-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, generated.filename), generated.source);
  writeFileSync(join(dir, "test.ts"), `import type { Collections, SchemaVersions } from "./zelavis-schema.js";
const valid: Collections["posts"] = { 'title"': "hello", status: "draft", author: { collection: "people", id: "a" }, rows: [{ score: 1 }], vector: [1, 0] as const };
// @ts-expect-error invalid literal choice
const status: Collections["posts"]["status"] = "unknown";
// @ts-expect-error required property absent
const missing: Collections["posts"] = { status: "draft", author: { collection: "people", id: "a" }, rows: [] };
// @ts-expect-error optional does not mean nullable
const tags: Collections["posts"]["tags"] = null;
// @ts-expect-error reference collection is part of the type
const author: Collections["posts"]["author"] = { collection: "posts", id: "a" };
// @ts-expect-error vector dimension is part of the type
const vector: Collections["posts"]["vector"] = [1, 0, 0] as const;
const historical: SchemaVersions["posts@2"] = {};
void [valid, status, missing, tags, author, vector, historical];\n`);
  const require = createRequire(import.meta.url);
  const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    noEmit: true, strict: true, exactOptionalPropertyTypes: true, types: [], target: "ES2022", module: "NodeNext",
  }, files: ["test.ts"] }));
  const result = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
