/**
 * Fills a collection, then activates a schema over it and announces that it is
 * about to, so the parent can kill the process partway through the backfill.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { Effect, Fiber } from "effect";
import { makeDatabase, partitionMapFor } from "../../dist/db/index.js";
import { makeNodeSqliteStore } from "../../dist/db/engines/node-sqlite.js";

const [, , directory, markerPath, count] = process.argv;
const marker = openSync(markerPath, "a");
const say = (line) => { writeSync(marker, `${line}\n`); fsyncSync(marker); };

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* makeDatabase({
    partitionMap: partitionMapFor(["only"]),
    openShard: (shard) => makeNodeSqliteStore(shard, directory),
  });
  const acme = db.forTenant("acme");
  yield* acme.documents.createCollection({ name: "posts" });
  const total = Number(count);
  for (let at = 0; at < total; at += 500) {
    yield* acme.documents.write({
      operations: Array.from({ length: Math.min(500, total - at) }, (_, i) => ({
        _tag: "Upsert", collection: "posts", id: `p${at + i}`, data: { title: `searchable post ${at + i}`, views: at + i },
      })),
    });
  }
  yield* acme.schemas.save({
    collection: "posts", version: 1, activate: false,
    fields: [
      { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
      { name: "views", field: { _tag: "IntegerField", label: "Views", required: false } },
    ],
  });
  say("activating");
  // Announce the intent once it is committed, so the parent kills the backfill rather than the moment before it.
  const activation = yield* Effect.forkChild(acme.schemas.activate("posts", 1));
  while ((yield* acme.schemas.pendingActivations).length === 0 && activation.pollUnsafe() === undefined) yield* Effect.sleep("1 millis");
  say("intent");
  yield* Fiber.join(activation);
  say("activated");
  closeSync(marker);
})));
