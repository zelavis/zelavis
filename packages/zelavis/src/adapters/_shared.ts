import { integrationValue, unwrapIntegrationResult, presentProtocol, present, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { Effect, Semaphore } from "effect";
import { isUnknown, optional, objectFields, parseJson } from "../core/json-validation.js";
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ZelavisFileStorage,
  ZelavisFileStorageCondition,
  ZelavisFileStorageEntry,
  ZelavisFileStorageObject,
  ZelavisFileStoragePutInput,
  ZelavisKeyValueStore,
} from "../index.js";
import { ZelavisStorageConditionError } from "../storage/conditions.js";

const STORAGE_METADATA_SUFFIX = ".zelavis-meta.json";
/** Marks the private file a conditional write stages its bytes in. */
const STORAGE_TEMP_MARKER = ".zelavis-tmp-";

/** Entries read at once when listing: a large store must not open a descriptor per object. */
const LIST_CONCURRENCY = 32;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Writes to one stored object, one at a time within this process.
 *
 * A conditional overwrite compares the current version and then replaces it;
 * any other write to the same object landing between the two would be lost
 * under a write that claimed it had seen the latest version. So every write
 * and delete of an object takes its turn here, keyed by absolute path so two
 * storage instances over one directory share the queue.
 */
const localWriteGates = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

function serializeLocalWrite<A, E>(key: string, run: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const entry = localWriteGates.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      entry.users += 1;
      localWriteGates.set(key, entry);
      return entry;
    }),
    (entry) => entry.semaphore.withPermit(run),
    (entry) => Effect.sync(() => { if ((entry.users -= 1) === 0) localWriteGates.delete(key); }),
  );
}

/** The errno a failed filesystem call carried, whatever wrapped it on the way. */
const errnoOf = (failure: IntegrationFailure): string | undefined =>
  (unwrapFailure(failure) as NodeJS.ErrnoException | undefined)?.code;

function normalizeStoragePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error("Storage path must not contain null bytes.");
  }
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof Blob !== "undefined" &&
    value instanceof Blob
  );
}

function isReadableByteStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

function toBytes(
  body: ZelavisFileStoragePutInput["body"],
): Promise<Uint8Array> {
    return present(Effect.gen(function* (): Effect.fn.Return<Uint8Array, IntegrationFailure> {
  if (typeof body === "string") {
    return (yield* integrationValue(new TextEncoder().encode(body)));
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (isBlobLike(body)) {
    return new Uint8Array((yield* integrationValue(body.arrayBuffer())));
  }

  if (!isReadableByteStream(body)) {
    throw new TypeError("Unsupported file storage body input.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const next = (yield* integrationValue(reader.read()));
    if (next.done) {
      break;
    }

    chunks.push(next.value);
    total += next.value.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}));
  }

export function createMemoryKeyValueStore(): ZelavisKeyValueStore {
  const store = new Map<string, string>();

  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
    delete(key) {
      return store.delete(key);
    },
    list(prefix) {
      return [...store.keys()]
        .filter((key) => (prefix ? key.startsWith(prefix) : true))
        .sort((left, right) => left.localeCompare(right));
    },
  };
}

function walkFiles(root: string, current = root): Promise<string[]> {
    return present(Effect.gen(function* (): Effect.fn.Return<string[], IntegrationFailure> {
  const entries = (yield* integrationValue(readdir(current, { withFileTypes: true })));
  const files: string[] = [];

  for (const entry of entries) {
    const nextPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...((yield* integrationValue(walkFiles(root, nextPath)))));
      continue;
    }

    const relativePath = relative(root, nextPath).replace(/\\/g, "/");
    if (
      relativePath.endsWith(STORAGE_METADATA_SUFFIX) ||
      relativePath.includes(STORAGE_TEMP_MARKER)
    ) {
      continue;
    }

    files.push(relativePath);
  }

  return files;
}));
  }

export function createLocalFileStorage(rootDirectory: string): ZelavisFileStorage {
  const rootPath = resolve(rootDirectory);

  function resolvePath(path: string): string {
    const normalized = normalizeStoragePath(path);
    const target = resolve(rootPath, normalized);
    if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
      throw new Error(`Path escapes storage root: "${path}"`);
    }
    return target;
  }

  function resolveMetadataPath(path: string): string {
    return `${resolvePath(path)}${STORAGE_METADATA_SUFFIX}`;
  }

  const pruneEmptyParents = (path: string): Effect.Effect<void, IntegrationFailure> => Effect.gen(function* () {
    let current = dirname(resolvePath(path));
    while (current !== rootPath && current.startsWith(`${rootPath}${sep}`)) {
      const occupied = yield* integrationValue(rmdir(current)).pipe(
        Effect.as(false),
        Effect.catch((failure) => {
          const code = errnoOf(failure);
          if (code === "ENOENT") return Effect.succeed(false);
          if (code === "ENOTEMPTY" || code === "EEXIST") return Effect.succeed(true);
          return Effect.fail(failure);
        }),
      );
      if (occupied) return;
      current = dirname(current);
    }
  });

  function readStoredMetadata(path: string): Promise<{
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
    checksum?: string;
  }> { return presentProtocol(Effect.gen(function* () {
    try {
      const raw = unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(resolveMetadataPath(path), "utf8"))));
      const parsed = parseJson(raw, objectFields<{
        contentType?: unknown;
        cacheControl?: unknown;
        contentDisposition?: unknown;
        metadata?: unknown;
        checksum?: unknown;
      }>({contentType: optional(isUnknown), cacheControl: optional(isUnknown), contentDisposition: optional(isUnknown), metadata: optional(isUnknown), checksum: optional(isUnknown)}));

      return {
        contentType:
          typeof parsed.contentType === "string" ? parsed.contentType : undefined,
        cacheControl:
          typeof parsed.cacheControl === "string" ? parsed.cacheControl : undefined,
        contentDisposition:
          typeof parsed.contentDisposition === "string"
            ? parsed.contentDisposition
            : undefined,
        metadata:
          parsed.metadata && typeof parsed.metadata === "object"
            ? (parsed.metadata as Record<string, string>)
            : undefined,
        checksum: typeof parsed.checksum === "string" ? parsed.checksum : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }

      throw error;
    }
  }).pipe(Effect.withSpan("createLocalFileStorage/readStoredMetadata"))); }

  const writeStoredMetadata = (
    path: string,
    value: {
      contentType?: string;
      cacheControl?: string;
      contentDisposition?: string;
      metadata?: Record<string, string>;
      checksum?: string;
    },
  ): Effect.Effect<void, IntegrationFailure> => Effect.gen(function* () {
    const metadataPath = resolveMetadataPath(path);

    if (
      !value.contentType &&
      !value.cacheControl &&
      !value.contentDisposition &&
      !value.metadata &&
      !value.checksum
    ) {
      yield* integrationValue(rm(metadataPath)).pipe(Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.void));
      return;
    }

    yield* integrationValue(mkdir(dirname(metadataPath), { recursive: true }));
    yield* integrationValue(writeFile(metadataPath, JSON.stringify(value, null, 2)));
  });

  /**
   * A write that happens only if its condition holds.
   *
   * The bytes are staged in a private file first, so no reader ever sees a
   * partial object. `ifAbsent` is then exact across processes: the staged file
   * is hard-linked into place, which the filesystem refuses when the name
   * exists. `ifMatch` compares the current version and renames over it, which
   * is exact among writers in this process because every write to an object
   * is queued (`serializeLocalWrite`). This backend is a single-process store:
   * a condition shared between processes or hosts belongs on an object store
   * that passes `probeFileStorageGuarantees`.
   */
  const writeConditionally = (
    filePath: string,
    path: string,
    bytes: Uint8Array,
    condition: ZelavisFileStorageCondition,
  ): Effect.Effect<void, IntegrationFailure | ZelavisStorageConditionError> => Effect.gen(function* () {
    const staged = `${filePath}${STORAGE_TEMP_MARKER}${randomBytes(8).toString("hex")}`;
    yield* integrationValue(writeFile(staged, bytes));
    yield* Effect.gen(function* () {
      if ("ifAbsent" in condition) {
        yield* integrationValue(link(staged, filePath)).pipe(
          Effect.catchIf((failure) => errnoOf(failure) === "EEXIST", () => Effect.fail(new ZelavisStorageConditionError(path, condition))),
        );
        return;
      }
      const current = yield* integrationValue(readFile(filePath)).pipe(
        Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.succeed(undefined)),
      );
      if (current === undefined || sha256Hex(current) !== condition.ifMatch) {
        return yield* Effect.fail(new ZelavisStorageConditionError(path, condition));
      }
      yield* integrationValue(rename(staged, filePath));
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      yield* integrationValue(rm(staged, { force: true }));
      yield* pruneEmptyParents(path);
    }).pipe(Effect.orDie)));
  });

  const removeStored = (path: string): Effect.Effect<boolean, IntegrationFailure> => Effect.gen(function* () {
    yield* Effect.all([
      integrationValue(rm(resolvePath(path))),
      integrationValue(rm(resolveMetadataPath(path))).pipe(Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.void)),
    ], { concurrency: 2 });
    yield* pruneEmptyParents(path);
    return true;
  }).pipe(Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.succeed(false)));

  const createEntry = (path: string): Effect.Effect<ZelavisFileStorageEntry, IntegrationFailure> => Effect.gen(function* () {
    const [info, stored] = yield* Effect.all([
      integrationValue(stat(resolvePath(path))),
      integrationValue(readStoredMetadata(path)),
    ], { concurrency: 2 });

    return {
      path: normalizeStoragePath(path),
      size: info.size,
      updatedAt: info.mtime,
      contentType: stored.contentType,
      cacheControl: stored.cacheControl,
      contentDisposition: stored.contentDisposition,
      metadata: stored.metadata,
      checksum: stored.checksum,
    };
  });

  return {
    capabilities: Object.freeze({ conditionalCreate: "host", conditionalReplace: "process" }),
    get(path): Promise<ZelavisFileStorageObject | undefined> {
      return present(Effect.gen(function* (): Effect.fn.Return<ZelavisFileStorageObject | undefined, IntegrationFailure> {
        const normalized = normalizeStoragePath(path);
        const filePath = resolvePath(normalized);
        const [body, info, stored] = yield* Effect.all([
          integrationValue(readFile(filePath)),
          integrationValue(stat(filePath)),
          integrationValue(readStoredMetadata(normalized)),
        ], { concurrency: 3 });

        return {
          path: normalized,
          body: new Uint8Array(body),
          size: info.size,
          updatedAt: info.mtime,
          contentType: stored.contentType,
          cacheControl: stored.cacheControl,
          contentDisposition: stored.contentDisposition,
          metadata: stored.metadata,
          checksum: stored.checksum,
          etag: sha256Hex(body),
        };
      }).pipe(Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.succeed(undefined))));
    },
    put(input) {
    return present(Effect.gen(function* () {
      const normalized = normalizeStoragePath(input.path);
      const filePath = resolvePath(normalized);
      const bytes = (yield* integrationValue(toBytes(input.body)));

      yield* serializeLocalWrite(filePath, Effect.gen(function* () {
        yield* integrationValue(mkdir(dirname(filePath), { recursive: true }));
        if (input.condition) {
          yield* writeConditionally(filePath, normalized, bytes, input.condition);
        } else {
          yield* integrationValue(writeFile(filePath, bytes));
        }
        yield* writeStoredMetadata(normalized, {
          contentType: input.contentType,
          cacheControl: input.cacheControl,
          contentDisposition: input.contentDisposition,
          metadata: input.metadata,
          checksum: input.metadata?.["checksum-sha256"],
        });
      }));

      const info = (yield* integrationValue(stat(filePath)));

      return {
        path: normalized,
        size: info.size,
        updatedAt: info.mtime,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        contentDisposition: input.contentDisposition,
        metadata: input.metadata,
        checksum: input.metadata?.["checksum-sha256"],
        etag: sha256Hex(bytes),
      };
    }));
  },
    delete(path) {
    return present(Effect.suspend(() => serializeLocalWrite(resolvePath(path), removeStored(path))));
  },
    list(prefix) {
      return present(Effect.gen(function* (): Effect.fn.Return<ZelavisFileStorageEntry[], IntegrationFailure> {
        const files = yield* integrationValue(walkFiles(rootPath)).pipe(
          Effect.catchIf((failure) => errnoOf(failure) === "ENOENT", () => Effect.succeed(undefined)),
        );
        if (!files) return [];
        const normalizedPrefix = prefix ? normalizeStoragePath(prefix) : undefined;

        return yield* Effect.forEach(
          files
            .filter((path) =>
              normalizedPrefix ? path.startsWith(normalizedPrefix) : true,
            )
            .sort((left, right) => left.localeCompare(right)),
          (path) => createEntry(path),
          { concurrency: LIST_CONCURRENCY },
        );
      }));
    },
  };
}
