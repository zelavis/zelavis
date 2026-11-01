// A divided Tenant is restored part by part. A part that fails after earlier parts were restored says which parts
// were and how to complete it: the same backup again with `into: "purge"`.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Cause } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { exportWholeTenant, restoreWholeTenant } from "../dist/db/divided-backup.js";

const database = () => makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), crossTenantRefresh: false, openShard: (shard) => openShardOverKv(shard, memoryKvEngine()) });
const seed = (tenant, ids) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "posts", columns: ["title"] });
  for (const id of ids) yield* tenant.documents.insert({ collection: "posts", id, data: { title: id } });
});
const titles = (tenant) => Effect.map(tenant.documents.findMany({ collection: "posts" }), (rows) => rows.map((row) => row.data.title).sort());

test("a divided restore cut off at one part names the parts restored, and a purge restore completes it", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const source = yield* database();
    yield* source.topology.subdivision.subdivide("whale", ["a", "b", "c"]);
    yield* seed(source.forPart("whale", "a"), ["a1", "a2"]);
    yield* seed(source.forPart("whale", "b"), ["b1"]);
    yield* seed(source.forPart("whale", "c"), ["c1"]);
    const backup = yield* exportWholeTenant(source, "whale");

    const target = yield* database();
    yield* target.topology.subdivision.subdivide("whale", ["a", "b", "c"]);
    // Part b's backup names another Tenant's partition, which its own restore refuses after a's is in.
    const broken = { ...backup, parts: backup.parts.map((entry) => entry.part === "b" ? { ...entry, backup: { ...entry.backup, events: [{ kind: "nonsense" }] } } : entry) };
    const cut = yield* Effect.exit(restoreWholeTenant(target, "whale", broken));
    assert.ok(Exit.isFailure(cut));
    const error = Cause.squash(cut.cause);
    assert.equal(error._tag, "DividedRestoreIncomplete", String(error));
    assert.deepEqual([error.restored, error.failedPart], [["a"], "b"]);
    assert.match(error.message, /into: "purge"/);

    const again = yield* Effect.exit(restoreWholeTenant(target, "whale", backup));
    assert.equal(Exit.isFailure(again) && Cause.squash(again.cause)._tag, "TenantNotEmpty", "an empty restore refuses what the cut-off one left");
    yield* restoreWholeTenant(target, "whale", backup, { into: "purge" });
    for (const [part, expected] of [["a", ["a1", "a2"]], ["b", ["b1"]], ["c", ["c1"]]]) {
      assert.deepEqual(yield* titles(target.forPart("whale", part)), expected, `part ${part} is whole`);
    }
  }))));
