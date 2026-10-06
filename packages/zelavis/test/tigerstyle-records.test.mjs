import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { parseJson, objectFields, isString, isJsonValue } from "../dist/core/json-validation.js";
import { documentRecord, collectionRecord } from "../dist/db/documents.js";
import { runtimeReleaseRecord } from "../dist/core/runtime/handover.js";
import { projectDescriptorRecord } from "../dist/adapters/_project-record-validation.js";
import { openStoreOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { manifestKey, payloadKey, metaKey } from "../dist/db/keys.js";
import { integrationValue, unwrapIntegrationResult, presentProtocol } from "../dist/core/runtime/effect-boundary.js";

const enc = new TextEncoder();
const encoded = value => enc.encode(JSON.stringify(value));
const at = "2026-10-06T00:00:00.000Z";
const document = { id: "record", collection: "items", data: { nested: [true, null, { value: 1 }] }, version: 1, createdAt: at, updatedAt: at };

test("record decoders reject primitives, malformed JSON and missing fields", () => {
  const check = objectFields({ name: isString });
  for (const source of ["null", "[]", "false", "1", '"name"', "{}", '{"name":1}', "{"]) {
    assert.throws(() => parseJson(source, check));
  }
  assert.deepEqual(parseJson('{"name":"safe","extra":true}', check), { name: "safe", extra: true });
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(isJsonValue(cyclic), false);
  assert.equal(isJsonValue({ value: Infinity }), false);
});

test("seeded persisted document mutations are refused with their reproducible seed", () => {
  const seed = 20261006;
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const mutations = [
    value => { value.version = 0; }, value => { value.version = 1.5; },
    value => { value.data = []; }, value => { value.createdAt = "invalid"; },
    value => { value.id = null; }, value => { delete value.updatedAt; },
    value => { value.highlights = { field: [1] }; }, value => { value.expiresAt = false; },
  ];
  for (let step = 0; step < 100; step++) {
    assert.deepEqual(parseJson(JSON.stringify(document), documentRecord), document);
    const index = random() % mutations.length;
    const corrupted = structuredClone(document); mutations[index](corrupted);
    assert.throws(() => parseJson(JSON.stringify(corrupted), documentRecord), undefined, `seed=${seed}, step=${step}, mutation=${index}`);
  }
  assert.throws(() => parseJson(JSON.stringify({ name: "items", createdAt: at, surface: "database", indexes: [{ name: "bad", fields: "not-an-array" }] }), collectionRecord));
});

test("release and Project authority decoders reject incomplete or malformed nested contracts", () => {
  assert.throws(() => parseJson('{"version":"1.0.0","digest":42}', runtimeReleaseRecord));
  assert.throws(() => parseJson('{"id":"project","recipe":{"version":true}}', projectDescriptorRecord));
});

test("corrupt index manifests refuse a write without changing the previous payload", async () => {
  const engine = memoryKvEngine();
  const store = await Effect.runPromise(openStoreOverKv("test", engine));
  const manifest = { terms: [], columns: [], measures: [], edges: [] };
  await Effect.runPromise(store.transact(txn => txn.put(1, enc.encode("original"), manifest)));
  await Effect.runPromise(engine.write([{ op: "put", key: manifestKey(1), value: encoded({ ...manifest, edges: [["edge", "wrong-id"]] }) }]));
  const before = await Effect.runPromise(engine.get(payloadKey(1)));
  await assert.rejects(Effect.runPromise(store.transact(txn => txn.put(1, enc.encode("replacement"), manifest))), /Malformed object-store record/);
  assert.deepEqual(await Effect.runPromise(engine.get(payloadKey(1))), before);
});

test("truncated stored counters cannot be coerced into valid sequence numbers", async () => {
  const engine = memoryKvEngine();
  const store = await Effect.runPromise(openStoreOverKv("test", engine));
  await Effect.runPromise(engine.write([{ op: "put", key: metaKey("next_seq"), value: Uint8Array.of(1, 2) }]));
  await assert.rejects(Effect.runPromise(store.nextSeq), /Truncated u32/);
});

test("Promise protocol presentation preserves the original error and completes local cleanup", async () => {
  const failure = new Error("write failed");
  const events = [];
  const program = Effect.fn("test.protocol")(function* () {
    try {
      unwrapIntegrationResult(yield* Effect.result(integrationValue(Promise.reject(failure))));
    } finally {
      events.push("cleanup");
    }
  });
  await assert.rejects(presentProtocol(program()), error => error === failure);
  assert.deepEqual(events, ["cleanup"]);
});
