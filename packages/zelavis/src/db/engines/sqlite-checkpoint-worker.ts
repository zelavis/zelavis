/**
 * The checkpointer of one process: a worker thread that folds every open SQLite shard's write-ahead log back into its
 * database file, so that work never runs inside a commit on the main thread. Without it, SQLite checkpoints inside
 * whichever commit crosses `wal_autocheckpoint`, and that commit, and the whole event loop with it, waits tens to
 * hundreds of milliseconds while pages are copied and synced.
 *
 * Each file gets a connection of its own here, and on every tick a passive checkpoint: it copies what no reader still
 * needs and never waits for a lock, so it cannot stall the writer or a snapshot. Its syncs follow the writer's
 * durability, `fullfsync` included for `power`. A file that fails to open or checkpoint is reported once per failure
 * kind and kept; the engine's own automatic checkpoint, raised but never turned off, keeps the log bounded whatever
 * happens here.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";

/** How often every open file is checkpointed. */
const TICK_MILLIS = 100;

/** At most this many files are checkpointed by one process; more are reported and left to their backstop. */
const MAX_FILES = 4096;

export type CheckpointRequest =
  | { readonly op: "open"; readonly id: number; readonly file: string; readonly power: boolean }
  | { readonly op: "close"; readonly id: number };

export type CheckpointReply =
  | { readonly op: "closed"; readonly id: number }
  | { readonly op: "failed"; readonly id: number; readonly reason: string };

interface Open {
  readonly db: DatabaseSync;
  /** The write-ahead log beside the file: no log, nothing to fold, and nothing created by asking. */
  readonly wal: string;
  readonly checkpoint: ReturnType<DatabaseSync["prepare"]>;
  /** The last failure reported for this file, so a failure that repeats on every tick is reported once. */
  reported?: string;
}

const files = new Map<number, Open>();

const isRequest = (value: unknown): value is CheckpointRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<{ op: unknown; id: unknown; file: unknown; power: unknown }>;
  if (!Number.isSafeInteger(request.id)) return false;
  if (request.op === "close") return true;
  return request.op === "open" && typeof request.file === "string" && typeof request.power === "boolean";
};

const reasonOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const port = parentPort;
if (port) {
  const report = (id: number, open: Open | undefined, cause: unknown) => {
    const reason = reasonOf(cause);
    if (open !== undefined) {
      if (open.reported === reason) return;
      open.reported = reason;
    }
    port.postMessage({ op: "failed", id, reason } satisfies CheckpointReply);
  };

  const open = (id: number, file: string, power: boolean) => {
    if (files.size >= MAX_FILES) return report(id, undefined, `this process already checkpoints ${MAX_FILES} files`);
    let db: DatabaseSync | undefined;
    try {
      // `mode=rw` opens the file only if it exists: this thread never creates a database, even for a file removed
      // since the engine opened it.
      const location = pathToFileURL(file);
      location.searchParams.set("mode", "rw");
      db = new DatabaseSync(location);
      // A checkpoint copies pages once: it needs no cache of its own and no mapping. It never waits for a lock:
      // a passive checkpoint that finds one busy simply copies less, and the next tick carries on.
      db.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA cache_size = -1024;
        PRAGMA mmap_size = 0;
        PRAGMA synchronous = ${power ? "FULL" : "NORMAL"};
        PRAGMA fullfsync = ${power ? "ON" : "OFF"};
      `);
      files.set(id, { db, wal: `${file}-wal`, checkpoint: db.prepare("PRAGMA wal_checkpoint(PASSIVE)") });
    } catch (cause) {
      try { db?.close(); } catch (cleanup) { return report(id, undefined, new AggregateError([cause, cleanup], "Opening the file to checkpoint it and closing it both failed.")); }
      report(id, undefined, cause);
    }
  };

  const close = (id: number) => {
    const held = files.get(id);
    files.delete(id);
    try {
      held?.db.close();
    } catch (cause) {
      report(id, undefined, cause);
    }
    port.postMessage({ op: "closed", id } satisfies CheckpointReply);
    // Nothing left to checkpoint: the thread ends, and the parent makes a new one for the next file.
    if (files.size === 0) {
      clearInterval(timer);
      port.close();
    }
  };

  const timer = setInterval(() => {
    for (const [id, held] of files) {
      // A checkpoint with no log would have SQLite create one (and its index) just to find it empty.
      if (!existsSync(held.wal)) continue;
      try {
        held.checkpoint.get();
        held.reported = undefined;
      } catch (cause) {
        report(id, held, cause);
      }
    }
  }, TICK_MILLIS);

  port.on("message", (message: unknown) => {
    if (!isRequest(message)) {
      const id = typeof message === "object" && message !== null && Number.isSafeInteger((message as { id?: unknown }).id) ? (message as { id: number }).id : -1;
      port.postMessage({ op: "failed", id, reason: "Malformed checkpoint request." } satisfies CheckpointReply);
      return;
    }
    if (message.op === "open") open(message.id, message.file, message.power);
    else close(message.id);
  });
}
