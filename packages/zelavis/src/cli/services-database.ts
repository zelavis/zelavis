import { runPlatformDatabaseCommand } from "./platform-database-restore.js";

/** Host-local replacement with the Platform stopped; the restored component is moved into place. */
export function runServicesDatabaseCommand(args: readonly string[]): Promise<void> {
  return runPlatformDatabaseCommand({ name: "services-database", component: "database", shard: "services-0", move: true }, args);
}
