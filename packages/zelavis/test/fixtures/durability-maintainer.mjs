/**
 * Runs one piece of upkeep on a pre-populated store, and announces that it is
 * about to.
 *
 * The marker is written and fsynced immediately before the work starts, so the
 * parent can kill the process partway through it rather than before or after.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { makeNodeSqliteStore } from "../../dist/db/engines/node-sqlite.js";

const [, , directory, markerPath, operation] = process.argv;
const marker = openSync(markerPath, "a");

await Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const store = (yield* makeNodeSqliteStore("acme", directory)).partition("acme");
    const work = operation === "rebuild" ? store.rebuildLenses
      : operation === "reindex" ? store.reindexLenses
        : operation === "snapshot" ? store.snapshot
          : store.compact({ keep: 10 });
    writeSync(marker, "started\n");
    fsyncSync(marker);
    yield* work;
    writeSync(marker, "done\n");
    fsyncSync(marker);
    closeSync(marker);
  })),
);
