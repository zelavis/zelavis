import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { openShardOverKv, openShardReaderOverKv } from "../dist/db/kv-store.js";
import { startRemoteShardAgent } from "./_remote-shard-fixture.mjs";

const remote = await startRemoteShardAgent();

test("a second claim on a remote shard fences the first writer at its next commit", async () => {
  await remote.commit("w1", { epoch: 1 });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const a = yield* openShardOverKv("w1", yield* remote.engine("w1"));
    yield* a.partition("t").reserve(5);
    const b = yield* openShardOverKv("w1", yield* remote.engine("w1"));
    assert.equal(b.generation, a.generation + 1);
    const failure = yield* Effect.flip(a.partition("t").reserve(10));
    assert.equal(failure._tag, "WriterFenced");
    yield* b.partition("t").reserve(10);
  })));
});

test("the Agent never claims a shard: the generation in its engine is the writer's", async () => {
  await remote.commit("w4", { epoch: 1 });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const a = yield* openShardOverKv("w4", yield* remote.engine("w4"));
    yield* a.partition("t").reserve(5);
    yield* Effect.promise(() => remote.restart());
    yield* openShardReaderOverKv("w4", yield* remote.engine("w4"));
    const b = yield* openShardOverKv("w4", yield* remote.engine("w4"));
    assert.equal(b.generation, a.generation + 1);
  })));
});
