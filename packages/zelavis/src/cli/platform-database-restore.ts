import { Data, Effect } from "effect";
import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { integration, present, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { acquireLocalDataOwnership } from "../adapters/_local-ownership.js";
import { openNodeDatabase } from "../db/node-host.js";
import { GLOBAL_SHARD, TOPOLOGY_SHARD } from "../db/topology.js";
import { resolveCliDataDirectory } from "./data-directory.js";

interface RestoreDatabase {
  readonly name: "identity-database" | "services-database";
  readonly component: "identity" | "database";
  readonly shard: string;
  readonly move: boolean;
}
class PlatformDatabaseRestoreRefused extends Data.TaggedError("PlatformDatabaseRestoreRefused")<{ readonly message: string }> {}
const missing = (failure: IntegrationFailure) => (unwrapFailure(failure) as NodeJS.ErrnoException).code === "ENOENT";

export const platformDatabaseRestoreUsage = (database: RestoreDatabase): string =>
  `zelavis ${database.name} restore DIR --confirm restore [--data-dir DIR] [--json]   (host-local, Platform stopped)\n` +
  `  DIR is a restored Platform backup run's \`${database.component}\` directory.`;

/** One maintenance ownership gate and replacement protocol for the Platform's private databases. */
const restore = Effect.fn("cli.platformDatabase.restore")(function* (database: RestoreDatabase, args: readonly string[]) {
  const usage = platformDatabaseRestoreUsage(database);
  let source: string | undefined, dataDir: string | undefined, confirm: string | undefined, json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--data-dir" || arg === "--confirm") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === "--data-dir") dataDir = value; else confirm = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown ${database.name} restore option "${arg}".`);
    if (source !== undefined) throw new Error(usage);
    source = arg;
  }
  if (source === undefined) throw new Error(`zelavis ${database.name} restore needs the restored ${database.component} directory.\n${usage}`);
  if (confirm !== "restore") throw new Error(`Restoring replaces the Platform's ${database.component}; repeat with --confirm restore, with the Platform stopped.`);
  const restored = resolve(source);
  const directory = resolveCliDataDirectory(dataDir);
  const lease = yield* integration(() => acquireLocalDataOwnership(directory, "maintenance")).pipe(
    Effect.catchIf((failure) => failure.message.includes("Local ownership is already reserved"), () =>
      Effect.fail(new PlatformDatabaseRestoreRefused({ message: "The Platform is running; stop it first." }))),
  );
  return yield* Effect.gen(function* () {
    const target = join(yield* integration(() => realpath(directory)), database.name, "shards");
    const invalid = () => new PlatformDatabaseRestoreRefused({ message: `${restored} is not a database image.` });
    const image = yield* integration(() => realpath(restored)).pipe(Effect.mapError(invalid));
    if (image === target || image.startsWith(`${target}${sep}`) || target.startsWith(`${image}${sep}`)) return yield* invalid();
    // A database opener creates missing shards. Require every shard of these fixed local databases first so an
    // empty, unrelated or incomplete directory cannot become a valid image merely by opening it.
    for (const shard of [TOPOLOGY_SHARD, GLOBAL_SHARD, database.shard]) {
      const file = yield* integration(() => lstat(join(image, `${shard}.sqlite`))).pipe(Effect.mapError(invalid));
      if (!file.isFile() || file.size === 0) return yield* invalid();
    }
    const opened = yield* integration(() => openNodeDatabase({ directory: image, backups: false, crossTenantRefresh: false })).pipe(Effect.mapError(invalid));
    yield* integration(() => opened.api.tenantUsage()).pipe(
      Effect.ensuring(integration(() => opened.close()).pipe(Effect.orDie)), Effect.mapError(invalid),
    );
    yield* integration(() => mkdir(dirname(target), { recursive: true }));
    const staged = database.move ? image : `${target}.restoring-${randomUUID()}`;
    const held = yield* integration(() => lstat(target)).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)));
    const replacedPath = held === undefined ? null : `${target}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    // Finish each filesystem operation before observing interruption; once the old shards move, either the image
    // takes their place or rollback restores them. A process crash is recovered by rerunning the command.
    yield* Effect.gen(function* () {
      if (!database.move) yield* integration(() => cp(image, staged, { recursive: true, errorOnExist: true, force: false }));
      if (replacedPath !== null) yield* integration(() => rename(target, replacedPath));
      yield* integration(() => rename(staged, target)).pipe(
        Effect.onError(() => replacedPath === null ? Effect.void : integration(() => rename(replacedPath, target)).pipe(Effect.orDie)),
      );
    }).pipe(
      Effect.uninterruptible,
      Effect.ensuring(database.move ? Effect.void : integration(() => rm(staged, { recursive: true, force: true })).pipe(Effect.orDie)),
    );
    console.log(json ? JSON.stringify({ restored: true, replacedPath }) : `Restored the ${database.name} into ${target}${replacedPath === null ? "." : `; the previous one is at ${replacedPath}.`}`);
  }).pipe(Effect.ensuring(integration(() => lease.release()).pipe(Effect.orDie)));
});

export function runPlatformDatabaseCommand(database: RestoreDatabase, args: readonly string[]): Promise<void> {
  return args[0] === "restore" ? present(restore(database, args.slice(1))) : present(Effect.sync(() => console.log(platformDatabaseRestoreUsage(database))));
}
