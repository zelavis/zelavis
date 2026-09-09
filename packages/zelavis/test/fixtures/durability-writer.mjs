/**
 * Writes objects one at a time until it is killed.
 *
 * A receipt is appended and fsynced only *after* a transaction has returned, so
 * a receipt on disk is a claim the database already made: this commit
 * completed. The parent kills the process and then holds the store to that
 * claim.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { asSeq } from "../../dist/db/index.js";

const [, , engine, directory, receiptPath, totalRaw] = process.argv;
const total = Number(totalRaw ?? 100000);
const enc = new TextEncoder();

const open = async () => {
  switch (engine) {
    case "libsql":
      // libSQL takes an options object; the rest take a bare directory.
      return (await import("../../dist/db/engines/libsql.js"))
        .makeLibsqlStore("acme", { directory });
    case "rocksdb":
      return (await import("../../dist/db/engines/rocksdb.js")).makeRocksdbStore("acme", directory);
    case "lmdb":
      return (await import("../../dist/db/engines/lmdb.js")).makeLmdbStore("acme", directory);
    default:
      return (await import("../../dist/db/engines/node-sqlite.js"))
        .makeNodeSqliteStore("acme", directory);
  }
};

const receipts = openSync(receiptPath, "a");

await Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const store = yield* yield* Effect.promise(open);
    for (let seq = 1; seq <= total; seq++) {
      yield* store.transact((txn) =>
        txn.put(
          asSeq(seq),
          enc.encode(JSON.stringify({ seq })),
          {
            terms: [["kind", "post"], ["tag", `t${seq % 16}`]],
            columns: [["region", `r${seq % 4}`]],
            measures: [["visits", seq]],
            edges: [],
          },
          { namespace: "doc/acme/posts", key: `p${seq}` },
        ));
      // The commit returned before this line runs, and this line is on disk
      // before the next one starts.
      writeSync(receipts, `${seq}\n`);
      fsyncSync(receipts);
    }
    closeSync(receipts);
  })),
);
