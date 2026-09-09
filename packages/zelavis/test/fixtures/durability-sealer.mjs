/**
 * Seals a pre-populated store, and announces that it is about to.
 *
 * The marker is written and fsynced immediately before the seal starts, so the
 * parent can kill the process partway through one rather than before or after.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { makeNodeSqliteStore } from "../../dist/db/engines/node-sqlite.js";

const [, , directory, markerPath] = process.argv;
const marker = openSync(markerPath, "a");

await Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const store = yield* makeNodeSqliteStore("acme", directory);
    writeSync(marker, "sealing\n");
    fsyncSync(marker);
    yield* store.sealPostings;
    writeSync(marker, "done\n");
    fsyncSync(marker);
    closeSync(marker);
  })),
);
