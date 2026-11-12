import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { DatabaseApi } from "./database.js";
import { makeLmdbEngine } from "./engines/lmdb.js";
import { makeNodeSqliteEngine } from "./engines/node-sqlite.js";
import { makeRocksdbJsEngine } from "./engines/rocksdb-js.js";
import { InvalidImage, StoreError } from "./errors.js";
import type { KvEngine } from "./kv.js";
import type { DatabaseImage, DatabaseImagesHost, DatabaseImageVerification } from "./runtime-api.js";
import type { ShardId } from "./topology.js";

/**
 * Database images on a Node host: a copy of every shard, byte for byte through the ordered key-value
 * interface, written as an ordinary shard directory of any local engine under `<images>/<name>/`.
 *
 * An image is opened by pointing a database at its directory with the engine it was written in; there is
 * deliberately no route that restores one, because replacing the live database is what the operator does
 * with the Project stopped, not something the database being replaced can authorize.
 *
 * Each shard's keys and values are read back once written and hashed (SHA-256 over every key and value,
 * length-prefixed, in key order), and the digest is kept with the image, so `verify` can say later whether
 * every shard still holds exactly what was written. Removing images is by name or by keeping only the newest.
 */

export const IMAGE_ENGINES = ["sqlite", "lmdb", "rocksdb"] as const;
export type ImageEngine = (typeof IMAGE_ENGINES)[number];
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METADATA = "image.json";

const failed = (op: string) => (cause: unknown) => new StoreError({ op, cause });

export const destinationEngine = (engine: ImageEngine, directory: string) => (shard: ShardId): Effect.Effect<KvEngine, StoreError, import("effect").Scope.Scope> => {
  switch (engine) {
    case "sqlite": return makeNodeSqliteEngine(shard, directory);
    case "lmdb": return makeLmdbEngine(shard, directory);
    case "rocksdb": return makeRocksdbJsEngine(shard, directory);
  }
};

/** Every key and value of one engine, in key order, hashed: what `verify` compares. */
const digestOf = (engine: KvEngine) =>
  Effect.gen(function* () {
    const hash = createHash("sha256");
    const length = Buffer.alloc(4);
    let keys = 0;
    yield* Stream.runForEach(engine.scan(new Uint8Array(0)), (entry) => Effect.sync(() => {
      for (const part of [entry.key, entry.value]) {
        length.writeUInt32BE(part.length, 0);
        hash.update(length);
        hash.update(part);
      }
      keys += 1;
    }));
    return { keys, digest: hash.digest("hex") };
  });

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
        const copied = yield* database.maintenance.image(destinationEngine(engine as ImageEngine, partial));
        // Read back what was written: a shard that does not hold every key copied is not an image.
        const shards = yield* Effect.forEach(copied, (entry) => Effect.scoped(Effect.gen(function* () {
          const read = yield* digestOf(yield* destinationEngine(engine as ImageEngine, partial)(entry.shard));
          if (read.keys !== entry.keys) {
            return yield* new StoreError({ op: "image.create", cause: `shard "${entry.shard}" holds ${read.keys} keys after copying ${entry.keys}` });
          }
          return { ...entry, digest: read.digest };
        })));
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

  const held = (name: string) =>
    Effect.gen(function* () {
      if (!IMAGE_NAME.test(name)) return yield* new InvalidImage({ reason: `"${name}" is not an image name.` });
      const image = yield* readMetadata(options.directory, name);
      if (image === undefined) return yield* new InvalidImage({ reason: `No image is named "${name}".` });
      return image;
    });

  const remove = (name: string) =>
    Effect.gen(function* () {
      const image = yield* held(name);
      // Out of the listing first (a rename is atomic), then removed: a removal cut off leaves nothing listed.
      const doomed = join(options.directory, `.removing-${name}-${crypto.randomUUID()}`);
      yield* Effect.tryPromise({ try: () => rename(join(options.directory, name), doomed), catch: failed("image.remove") });
      yield* Effect.tryPromise({ try: () => rm(doomed, { recursive: true, force: true }), catch: failed("image.remove") });
      return { name, bytes: image.bytes };
    });

  const verify = (name: string) =>
    Effect.gen(function* () {
      const image = yield* held(name);
      const directory = join(options.directory, name);
      const shards = yield* Effect.forEach(image.shards, (expected) => Effect.scoped(Effect.gen(function* () {
        const read = yield* Effect.flatMap(
          destinationEngine(image.engine as ImageEngine, directory)(expected.shard),
          digestOf,
        ).pipe(Effect.catchTag("StoreError", (error) => Effect.succeed({ keys: 0, digest: "", problem: String(error.cause) })));
        const problem = "problem" in read ? read.problem
          : expected.digest === undefined ? "the image records no digest for this shard"
            : read.keys !== expected.keys ? `holds ${read.keys} keys, ${expected.keys} were written`
              : read.digest !== expected.digest ? "its keys or values differ from what was written" : undefined;
        return { shard: expected.shard, keys: read.keys, ok: problem === undefined, ...(problem === undefined ? {} : { problem }) };
      })));
      return { name, ok: shards.every((shard) => shard.ok), verifiedAt: new Date().toISOString(), shards } satisfies DatabaseImageVerification;
    });

  /** Remove every image but the newest `keep`, oldest first. */
  const prune = (keep: number) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1000) {
        return yield* new InvalidImage({ reason: "keep is a whole number from 1 to 1000: retention never removes every image." });
      }
      const images = [...(yield* list)].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.name < b.name ? -1 : 1));
      const removed: string[] = [];
      for (const image of images.slice(0, Math.max(0, images.length - keep))) {
        yield* remove(image.name);
        removed.push(image.name);
      }
      return { removed, kept: images.slice(Math.max(0, images.length - keep)).map((image) => image.name) };
    });

  return {
    create: (name, createOptions) => Effect.runPromise(create(name, createOptions)),
    list: () => Effect.runPromise(list),
    remove: (name) => Effect.runPromise(remove(name)),
    verify: (name) => Effect.runPromise(verify(name)),
    prune: (keep) => Effect.runPromise(prune(keep)),
  };
};
