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
const localWriteQueues = new Map<string, Promise<unknown>>();

async function serializeLocalWrite<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = localWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  localWriteQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (localWriteQueues.get(key) === settled) localWriteQueues.delete(key);
  }
}

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

async function toBytes(
  body: ZelavisFileStoragePutInput["body"],
): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (isBlobLike(body)) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (!isReadableByteStream(body)) {
    throw new TypeError("Unsupported file storage body input.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const next = await reader.read();
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

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const nextPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, nextPath)));
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

  async function pruneEmptyParents(path: string): Promise<void> {
    let current = dirname(resolvePath(path));
    while (current !== rootPath && current.startsWith(`${rootPath}${sep}`)) {
      try {
        await rmdir(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          current = dirname(current);
          continue;
        }
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          return;
        }
        throw error;
      }
      current = dirname(current);
    }
  }

  async function readStoredMetadata(path: string): Promise<{
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
    checksum?: string;
  }> {
    try {
      const raw = await readFile(resolveMetadataPath(path), "utf8");
      const parsed = JSON.parse(raw) as {
        contentType?: unknown;
        cacheControl?: unknown;
        contentDisposition?: unknown;
        metadata?: unknown;
        checksum?: unknown;
      };

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
  }

  async function writeStoredMetadata(
    path: string,
    value: {
      contentType?: string;
      cacheControl?: string;
      contentDisposition?: string;
      metadata?: Record<string, string>;
      checksum?: string;
    },
  ): Promise<void> {
    const metadataPath = resolveMetadataPath(path);

    if (
      !value.contentType &&
      !value.cacheControl &&
      !value.contentDisposition &&
      !value.metadata &&
      !value.checksum
    ) {
      try {
        await rm(metadataPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }

    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(value, null, 2));
  }

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
  async function writeConditionally(
    filePath: string,
    path: string,
    bytes: Uint8Array,
    condition: ZelavisFileStorageCondition,
  ): Promise<void> {
    const staged = `${filePath}${STORAGE_TEMP_MARKER}${randomBytes(8).toString("hex")}`;
    await writeFile(staged, bytes);
    try {
      if ("ifAbsent" in condition) {
        try {
          await link(staged, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ZelavisStorageConditionError(path, condition);
          }
          throw error;
        }
        return;
      }
      const current = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (current === undefined || sha256Hex(current) !== condition.ifMatch) {
        throw new ZelavisStorageConditionError(path, condition);
      }
      await rename(staged, filePath);
    } finally {
      await rm(staged, { force: true });
    }
  }

  async function removeStored(path: string): Promise<boolean> {
    try {
      await Promise.all([
        rm(resolvePath(path)),
        rm(resolveMetadataPath(path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }),
      ]);
      await pruneEmptyParents(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  async function createEntry(path: string): Promise<ZelavisFileStorageEntry> {
    const [info, stored] = await Promise.all([
      stat(resolvePath(path)),
      readStoredMetadata(path),
    ]);

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
  }

  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      const normalized = normalizeStoragePath(path);
      try {
        const filePath = resolvePath(normalized);
        const [body, info, stored] = await Promise.all([
          readFile(filePath),
          stat(filePath),
          readStoredMetadata(normalized),
        ]);

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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }

        throw error;
      }
    },
    async put(input) {
      const normalized = normalizeStoragePath(input.path);
      const filePath = resolvePath(normalized);
      const bytes = await toBytes(input.body);

      await serializeLocalWrite(filePath, async () => {
        await mkdir(dirname(filePath), { recursive: true });
        if (input.condition) {
          await writeConditionally(filePath, normalized, bytes, input.condition);
        } else {
          await writeFile(filePath, bytes);
        }
        await writeStoredMetadata(normalized, {
          contentType: input.contentType,
          cacheControl: input.cacheControl,
          contentDisposition: input.contentDisposition,
          metadata: input.metadata,
          checksum: input.metadata?.["checksum-sha256"],
        });
      });

      const info = await stat(filePath);

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
    },
    async delete(path) {
      return serializeLocalWrite(resolvePath(path), () => removeStored(path));
    },
    async list(prefix) {
      try {
        const files = await walkFiles(rootPath);
        const normalizedPrefix = prefix ? normalizeStoragePath(prefix) : undefined;

        return Promise.all(
          files
            .filter((path) =>
              normalizedPrefix ? path.startsWith(normalizedPrefix) : true,
            )
            .sort((left, right) => left.localeCompare(right))
            .map((path) => createEntry(path)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw error;
      }
    },
  };
}
