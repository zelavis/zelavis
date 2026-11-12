import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeDatabase } from "../dist/db/node-host.js";

/**
 * A throwaway shard directory for one test.
 *
 * The database is durable now, and opening a shard claims the next writer
 * generation, so two tests sharing a directory would fence each other. Every
 * test that needs a database gets its own.
 */
export function temporaryDatabaseDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "zv-db-"));
  t?.after?.(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Two shards: enough for routing to be real without four files per test.
 *
 * Closed before its directory is removed, in one hook: hooks run in the order they are added, and removing a live
 * database's files races the threads still using them (its checkpoint thread among them).
 */
export async function openTemporaryDatabase(t, options = {}) {
  const directory = temporaryDatabaseDirectory();
  const opened = await openNodeDatabase({
    directory,
    shards: ["shard-0", "shard-1"],
    ...options,
  }).catch((error) => {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  });
  t?.after?.(async () => {
    await opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return opened;
}
