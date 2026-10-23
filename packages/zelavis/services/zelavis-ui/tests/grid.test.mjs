import test from "node:test";
import assert from "node:assert/strict";
import { gridData, cellValue, cellText, editText, parseEdit, changedRecord, pageNumber, parseFilter, parseSort, filterParam, columnKind, columnWidth, parseHidden, hiddenParam } from "../app/grids/model.ts";
import { gridNotices } from "../scripts/grid-licenses.mjs";
test("JSON cell editing preserves every JSON type and distinguishes missing from null", () => {
  for (const value of ["42", 42, true, false, null, [], [1, "a"], { score: 1 }]) assert.deepEqual(parseEdit(editText(value)), value);
  assert.equal(editText(undefined), ""); assert.equal(cellText(undefined), "(missing)"); assert.equal(cellText(null), "null");
  assert.throws(() => parseEdit("")); assert.throws(() => parseEdit("not JSON")); assert.throws(() => parseEdit("1e999"), /finite/); assert.throws(() => parseEdit('{"score":1e999}'), /finite/); assert.throws(() => parseEdit("x".repeat(1048577)));
});
test("literal dotted and prototype property names remain independent database fields", () => {
  const data = JSON.parse('{"literal.key":4,"__proto__":{"safe":true},"constructor":"value"}');
  const {records,columns} = gridData([{id:"a",data,version:3},{id:"b",data:{}}]);
  assert.equal(cellValue(records[0],columns.find(c=>c.key==="literal.key")),4);
  const edited = changedRecord(records[0],"__proto__",{ safe: false });
  assert.equal(Object.getPrototypeOf(edited.data),Object.prototype);
  assert.deepEqual(edited.data.__proto__,{safe:false}); assert.equal(edited.version,3);
  assert.deepEqual(records[0].data.__proto__,{safe:true});
  assert.equal(cellValue(records[1],columns.find(c=>c.key==="constructor")),undefined);
});
test("malformed rows and duplicate IDs are refused", () => {
  for(const rows of [[null],[{id:'a',data:[]}],[{id:'a',data:{}},{id:'a',data:{}}]]) assert.throws(()=>gridData(rows));
});
test("URL pagination is bounded", () => {
  assert.equal(pageNumber("-3",25,250),25); assert.equal(pageNumber("99999",25,250),250); assert.equal(pageNumber("25garbage",25,250),25);
});
test("the exact grid release requires MIT and retains its notice", () => {
  const notices=gridNotices(); for(const name of ["@glideapps/glide-data-grid@6.0.3"]) assert.ok(notices.includes(name));
});

test("column identities survive sparse pages and adding fields to a record", () => {
  const before=gridData([{id:"a",data:{title:"A","literal.key":true}}]);
  const after=gridData([{id:"b",data:{added:42,title:"B"}}]);
  assert.equal(before.columns.find(c=>c.key==="title").field,after.columns.find(c=>c.key==="title").field);
  assert.ok(before.columns.every(c=>!c.field.includes(".")));
});

test("filter and sort URL state is validated before it reaches the query", () => {
  assert.deepEqual(parseFilter(filterParam("count", "gte", "5")), { path: "count", op: "gte", value: 5 });
  assert.deepEqual(parseFilter("title|eq|draft"), { path: "title", op: "eq", value: "draft" });
  assert.deepEqual(parseFilter("title|eq|a|b"), { path: "title", op: "eq", value: "a|b" });
  for (const bad of [null, "", "title", "title|like|x", "|eq|1", "title|eq"]) assert.equal(parseFilter(bad), undefined);
  assert.deepEqual(parseSort("count:desc"), { path: "count", direction: "desc" });
  assert.deepEqual(parseSort("a:b:asc"), { path: "a:b", direction: "asc" });
  for (const bad of [null, "", "count", "count:up", ":asc"]) assert.equal(parseSort(bad), undefined);
});

test("column kinds come from the loaded values and ignore null and missing", () => {
  const { records, columns } = gridData([{ id: "a", data: { n: 1, s: "x", b: true, o: { k: 1 }, m: 1, e: null } }, { id: "b", data: { n: 2, s: "y", b: false, m: "text" } }]);
  const kind = key => columnKind(records, columns.find(c => c.key === key));
  assert.equal(kind("n"), "number"); assert.equal(kind("s"), "string"); assert.equal(kind("b"), "boolean");
  assert.equal(kind("o"), "structure"); assert.equal(kind("m"), "mixed"); assert.equal(kind("e"), "empty");
  assert.equal(columnKind(records, columns[0]), "id");
});
test("column widths fit the content within bounds", () => {
  const { records, columns } = gridData([{ id: "a", data: { short: 1, long: "x".repeat(500) } }]);
  const width = key => columnWidth(records, columns.find(c => c.key === key));
  assert.equal(width("short"), 96); assert.equal(width("long"), 360);
});
test("hidden columns round-trip through the URL and refuse malformed state", () => {
  assert.deepEqual(parseHidden(hiddenParam(["a,b", "c|d", "é"])), ["a,b", "c|d", "é"]);
  assert.equal(hiddenParam([]), undefined);
  for (const bad of [null, "", "nope", "{}", "[1,2]"]) assert.deepEqual(parseHidden(bad), []);
});
