import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { DatabaseApi } from "./database.js";
import { makeLibsqlEngine } from "./engines/libsql.js";
import { makeLmdbEngine } from "./engines/lmdb.js";
import { makeNodeSqliteEngine } from "./engines/node-sqlite.js";
import { makeRocksdbJsEngine } from "./engines/rocksdb-js.js";
import { InvalidImage, StoreError } from "./errors.js";
import type { KvEngine } from "./kv.js";
import type { DatabaseImage, DatabaseImagesHost } from "./runtime-api.js";
import type { ShardId } from "./topology.js";

/**
 * Database images on a Node host: a copy of every shard, byte for byte through the ordered key-value
 * interface, written as an ordinary shard directory of any local engine under `<images>/<name>/`.
 *
 * An image is opened by pointing a database at its directory with the engine it was written in; there is
 * deliberately no route that restores one, because replacing the live database is what the operator does
 * with the Project stopped, not something the database being replaced can authorize.
 */

const IMAGE_ENGINES = ["sqlite", "lmdb", "rocksdb", "libsql"] as const;
type ImageEngine = (typeof IMAGE_ENGINES)[number];
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METADATA = "image.json";

const failed = (op: string) => (cause: unknown) => new StoreError({ op, cause });

const destinationEngine = (engine: ImageEngine, directory: string) => (shard: ShardId): Effect.Effect<KvEngine, StoreError, import("effect").Scope.Scope> => {
  switch (engine) {
    case "sqlite": return makeNodeSqliteEngine(shard, directory);
    case "lmdb": return makeLmdbEngine(shard, directory);
    case "rocksdb": return makeRocksdbJsEngine(shard, directory);
    case "libsql": return makeLibsqlEngine(shard, { directory });
  }
};

const readMetadata = (directory: string, name: string): Effect.Effect<DatabaseImage | undefined, StoreError> =>
  Effect.tryPromise({ try: () => readFile(join(directory, name, METADATA), "utf8"), catch: failed("image.read") }).pipe(
    Effect.map((text): DatabaseImage | undefined => {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as DatabaseImage) : undefined;
    }),
    // A directory with no readable metadata is not a finished image (an unfinished copy keeps its own name): not listed.
    Effect.catchTag("StoreError", () => Effect.succeed(undefined)),
  );

export const imagesHost = (
  database: DatabaseApi,
  options: { readonly directory: string; readonly engine: string },
): DatabaseImagesHost => {
  const list = Effect.gen(function* () {
    const names = yield* Effect.tryPromise({ try: () => readdir(options.directory), catch: failed("image.list") }).pipe(
      Effect.catchTag("StoreError", () => Effect.succeed([] as string[])),
    );
    const images: DatabaseImage[] = [];
    for (const name of names.filter((entry) => IMAGE_NAME.test(entry)).sort()) {
      const image = yield* readMetadata(options.directory, name);
      if (image !== undefined) images.push(image);
    }
    return images;
  });

  const create = (name: string, createOptions?: { readonly engine?: string }) =>
    Effect.gen(function* () {
      if (!IMAGE_NAME.test(name)) {
        return yield* new InvalidImage({ reason: "An image name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit." });
      }
      const engine = createOptions?.engine ?? (IMAGE_ENGINES.includes(options.engine as ImageEngine) ? options.engine : "sqlite");
      if (!IMAGE_ENGINES.includes(engine as ImageEngine)) {
        return yield* new InvalidImage({ reason: `An image is written to a local engine: ${IMAGE_ENGINES.join(", ")}, not "${engine}".` });
      }
      if ((yield* readMetadata(options.directory, name)) !== undefined) {
        return yield* new InvalidImage({ reason: `An image named "${name}" already exists.` });
      }
      // Written under a name nothing lists, and renamed into place only once whole.
      const partial = join(options.directory, `.partial-${name}-${crypto.randomUUID()}`);
      const final = join(options.directory, name);
      yield* Effect.tryPromise({ try: () => mkdir(partial, { recursive: true }), catch: failed("image.create") });
      return yield* Effect.gen(function* () {
        const shards = yield* database.maintenance.image(destinationEngine(engine as ImageEngine, partial));
        const keys = shards.reduce((sum, entry) => sum + entry.keys, 0);
        const bytes = shards.reduce((sum, entry) => sum + entry.bytes, 0);
        const image: DatabaseImage = { name, createdAt: new Date().toISOString(), engine, keys, bytes, shards };
        yield* Effect.tryPromise({ try: () => writeFile(join(partial, METADATA), `${JSON.stringify(image, null, 2)}\n`, { mode: 0o600 }), catch: failed("image.create") });
        yield* Effect.tryPromise({ try: () => rename(partial, final), catch: failed("image.create") });
        return image;
      }).pipe(
        // A copy cut off by a failure leaves nothing a listing would offer.
        Effect.tapError(() => Effect.orDie(Effect.tryPromise({ try: () => rm(partial, { recursive: true, force: true }), catch: failed("image.discard") }))),
      );
    });

  return {
    create: (name, createOptions) => Effect.runPromise(create(name, createOptions)),
    list: () => Effect.runPromise(list),
  };
};
