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

/** Two shards: enough for routing to be real without four files per test. */
export async function openTemporaryDatabase(t, options = {}) {
  const opened = await openNodeDatabase({
    directory: temporaryDatabaseDirectory(t),
    shards: ["shard-0", "shard-1"],
    ...options,
  });
  t?.after?.(() => opened.close());
  return opened;
}
