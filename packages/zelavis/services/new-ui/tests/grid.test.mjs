import test from "node:test";
import assert from "node:assert/strict";
import { gridData, cellValue, cellText, editText, parseEdit, changedRecord, pageNumber, gridLibrary } from "../app/grids/model.ts";
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
test("URL pagination is bounded and unknown libraries select Glide", () => {
  assert.equal(pageNumber("-3",25,250),25); assert.equal(pageNumber("99999",25,250),250); assert.equal(pageNumber("25garbage",25,250),25);
  assert.equal(gridLibrary("tabulator"),"tabulator"); assert.equal(gridLibrary("vtable"),"vtable"); assert.equal(gridLibrary("external"),"glide");
});
test("the exact three grid releases and VTable editor require MIT and retain notices", () => {
  const notices=gridNotices(); for(const name of ["@glideapps/glide-data-grid@6.0.3","tabulator-tables@6.6.1","@visactor/vtable@1.26.8","@visactor/vtable-editors@1.26.8"]) assert.ok(notices.includes(name));
});

test("column identities survive sparse pages and adding fields to a record", () => {
  const before=gridData([{id:"a",data:{title:"A","literal.key":true}}]);
  const after=gridData([{id:"b",data:{added:42,title:"B"}}]);
  assert.equal(before.columns.find(c=>c.key==="title").field,after.columns.find(c=>c.key==="title").field);
  assert.ok(before.columns.every(c=>!c.field.includes(".")));
});
