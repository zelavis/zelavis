/**
 * Serves durable entities on a database on disk until it is killed, or until nothing is owed (then it exits 0).
 *
 * The handler raises a counter document per entity and inserts one document named by the message's key, with a
 * random pause first so a kill lands anywhere: before the handler, inside it, around its commit. The parent kills
 * the process again and again and then holds the database to exactly one counted effect per message.
 */
import { Effect } from "effect";
import { openNodeDatabase } from "../../dist/db/node-host.js";

const [, , directory] = process.argv;
const opened = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"], crossTenantRefresh: false });
const db = opened.database;

const handler = (message, context) =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${Math.floor(Math.random() * 4)} millis`);
    const documents = db.forTenant(context.tenant).documents;
    const counter = yield* documents.findById({ collection: "counters", id: message.id });
    const count = (counter?.data.count ?? 0) + 1;
    return {
      writes: [
        counter === undefined
          ? { _tag: "Insert", collection: "counters", id: message.id, data: { count } }
          : { _tag: "Update", collection: "counters", id: message.id, data: { count }, expectedVersion: counter.version },
        { _tag: "Insert", collection: "effects", id: message.messageKey, data: { entity: message.id } },
      ],
      state: { last: message.payload.n },
      reply: { count },
    };
  });

const owed = Effect.gen(function* () {
  let pending = 0;
  for (const tenant of ["acme", "globex"]) {
    for (const id of ["a", "b", "c", "d"]) pending += (yield* db.forTenant(tenant).entities.state({ type: "counter", id }))?.pending ?? 0;
  }
  return pending;
});

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  yield* Effect.forkScoped(db.entities.serve({ handlers: (type) => (type === "counter" ? handler : undefined), sweepInterval: "50 millis", concurrency: 4 }));
  console.log("serving");
  while ((yield* owed) > 0) yield* Effect.sleep("20 millis");
})));
await opened.close();
console.log("done");
