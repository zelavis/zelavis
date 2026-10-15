import test from "node:test";
import assert from "node:assert/strict";
import { parseSchemaFields, schemaVersions, nextSchemaVersion } from "../app/schema-editor.ts";
const field = (name, tag = "TextField") => ({ name, field: { _tag: tag, label: name, required: false } });
test("schema field parsing uses the public typed codec and preserves nested definitions", () => {
  const fields = [field("title"), { name: "items", field: { _tag: "RepeaterField", label: "Items", required: false, fields: [field("quantity", "IntegerField")] } }];
  assert.deepEqual(parseSchemaFields(JSON.stringify(fields)), fields);
  for (const value of [[field("x"), field("x")], [field("not valid")], [field("x", "InventedField")], [{ name: "x", field: { _tag: "BooleanField", label: "X", required: "yes" } }]]) assert.throws(() => parseSchemaFields(JSON.stringify(value)));
});
test("field depth, count and input size are bounded", () => {
  assert.throws(() => parseSchemaFields(" ".repeat(1048577)), /1 MB/);
  assert.throws(() => parseSchemaFields(JSON.stringify(Array.from({ length: 257 }, (_, n) => field(`field${n}`)))), /256 fields/);
  let values = [field("leaf")]; for (let i = 0; i < 14; i++) values = [{ name: "nested", field: { _tag: "RepeaterField", label: "Nested", required: false, fields: values } }];
  assert.throws(() => parseSchemaFields(JSON.stringify(values)), /nested field levels/);
});
test("version selection never invents active schemas or overwrites a saved version", () => {
  const schemas = [{ collection: "articles", version: 3, active: true, fields: [field("title")] }, { collection: "articles", version: 1, active: false, fields: [] }];
  assert.equal(nextSchemaVersion(schemaVersions(JSON.stringify(schemas))), 4);
  assert.equal(nextSchemaVersion([]), 1);
  assert.throws(() => schemaVersions(JSON.stringify([schemas[0], schemas[0]])), /version catalogue/);
  assert.throws(() => schemaVersions(JSON.stringify(schemas.map(schema => ({ ...schema, active: true })))), /multiple active/);
  assert.throws(() => nextSchemaVersion([{ version: Number.MAX_SAFE_INTEGER }]));
});
