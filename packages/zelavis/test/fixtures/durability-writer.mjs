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

/**
 * `ZV_ENGINE_CHECKPOINTS=1` (SQLite only): the shard checkpoints the way SQLite does by itself, inside a commit past
 * 16 MiB of log (4,000 pages of 4 KiB), rather than on the checkpoint thread, so every commit here is still in the write-ahead log when the
 * process is killed. A test that cuts the log to simulate a power cut needs that: a checkpoint syncs the log before it
 * writes the file, so a cut below a checkpoint is not a state a power cut can leave, and cutting there would only
 * corrupt a copy in a way no machine could.
 */
const engineCheckpoints = async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const { sqliteKvEngineOver } = await import("../../dist/db/engines/sqlite-kv.js");
  const { openShardOverKv } = await import("../../dist/db/kv-store.js");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "acme.sqlite");
  const kv = sqliteKvEngineOver(new DatabaseSync(file), { openReader: () => new DatabaseSync(file, { readOnly: true }), checkpoints: "engine" });
  return openShardOverKv("acme", kv);
};

const open = async () => {
  if (engine === "sqlite" && process.env.ZV_ENGINE_CHECKPOINTS === "1") return engineCheckpoints();
  switch (engine) {
    case "lmdb":
      return (await import("../../dist/db/engines/lmdb.js")).makeLmdbStore("acme", directory);
    case "rocksdb-js":
      return (await import("../../dist/db/engines/rocksdb-js.js"))
        .makeRocksdbJsStore("acme", directory);
    default:
      return (await import("../../dist/db/engines/node-sqlite.js"))
        .makeNodeSqliteStore("acme", directory);
  }
};

const receipts = openSync(receiptPath, "a");

await Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const store = (yield* yield* Effect.promise(open)).partition("acme");
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
