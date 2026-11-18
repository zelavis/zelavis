import { runPlatformDatabaseCommand } from "./platform-database-restore.js";

/** The identity component is copied so the restored Auth image remains available for recovery. */
export function runIdentityDatabaseCommand(args: readonly string[]): Promise<void> {
  return runPlatformDatabaseCommand({ name: "identity-database", component: "identity", shard: "identity-0", move: false }, args);
}
