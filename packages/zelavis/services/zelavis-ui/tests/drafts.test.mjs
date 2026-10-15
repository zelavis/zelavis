import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { draftJournal } from "../app/grids/drafts.ts";
class MemoryStorage {
  values = new Map(); get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const identity = { draftScope: "a".repeat(64), projectId: "project", tenant: "tenant", collection: "table" };
const row = { id: "record", version: 3, data: { title: "unsaved" } };
test("hard reload restores original versions and incomplete inspector text", () => {
  const storage = new MemoryStorage();
  Effect.runSync(draftJournal(storage, identity).write({ records: [row], inspector: { id: row.id, version: 3, text: '{"unfinished":' } }));
  const restored = Effect.runSync(draftJournal(storage, identity).read);
  assert.deepEqual(restored.records, [row]); assert.equal(restored.inspector.text, '{"unfinished":'); assert.equal(restored.records[0].version, 3);
});
test("different sessions, Projects, Tenants and tables cannot restore another journal", () => {
  const storage = new MemoryStorage(); Effect.runSync(draftJournal(storage, identity).write({ records: [row] }));
  for (const key of Object.keys(identity)) {
    const other = { ...identity, [key]: key === "draftScope" ? "b".repeat(64) : "other" };
    assert.deepEqual(Effect.runSync(draftJournal(storage, other).read), { records: [] });
  }
});
test("saved/discarded drafts remove the journal", () => {
  const storage = new MemoryStorage(); const journal = draftJournal(storage, identity);
  Effect.runSync(journal.write({ records: [row] })); Effect.runSync(journal.write({ records: [] })); assert.equal(storage.length, 0);
});
test("expired, malformed and oversized journals fail explicitly", () => {
  const storage = new MemoryStorage(); let now = 1000; const journal = draftJournal(storage, identity, () => now);
  Effect.runSync(journal.write({ records: [row] })); now += 86400001; assert.throws(() => Effect.runSync(journal.read), /expired/);
  storage.values.set(storage.key(0), "invalid"); assert.throws(() => Effect.runSync(journal.read));
  storage.values.set(storage.key(0), "x".repeat(1048577)); assert.throws(() => Effect.runSync(journal.read), /limit/);
});
test("drafts without optimistic concurrency versions and storage failures are visible", () => {
  const storage = new MemoryStorage(); const journal = draftJournal(storage, identity);
  assert.throws(() => Effect.runSync(journal.write({ records: [{ ...row, version: undefined }] })), /original record versions/);
  storage.setItem = () => { throw new Error("quota"); }; assert.throws(() => Effect.runSync(journal.write({ records: [row] })), /quota/);
});
test("the aggregate storage budget never evicts another valid journal", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < 32; index++) Effect.runSync(draftJournal(storage, { ...identity, collection: String(index) }).write({ records: [row] }));
  assert.throws(() => Effect.runSync(draftJournal(storage, identity).write({ records: [row] })), /full/); assert.equal(storage.length, 32);
});

test("schema journals share bounds and sign-out cleanup but never overwrite record journals", () => {
  const storage = new MemoryStorage();
  Effect.runSync(draftJournal(storage, identity).write({ records: [row] }));
  const schema = draftJournal(storage, { ...identity, kind: "schema" });
  Effect.runSync(schema.write({ records: [], inspector: { id: "schema", version: 4, text: "[{unfinished" } }));
  assert.equal(Effect.runSync(schema.read).inspector.version, 4);
  assert.deepEqual(Effect.runSync(draftJournal(storage, identity).read).records, [row]);
  assert.equal(storage.length, 2);
});
