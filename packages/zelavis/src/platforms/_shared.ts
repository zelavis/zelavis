import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  ZelavisFileStorage,
  ZelavisFileStorageEntry,
  ZelavisFileStorageObject,
  ZelavisFileStoragePutInput,
  ZelavisKeyValueStore,
} from "../index.js";

const STORAGE_METADATA_SUFFIX = ".zelavis-meta.json";

function normalizeStoragePath(path: string): string {
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
    if (relativePath.endsWith(STORAGE_METADATA_SUFFIX)) {
      continue;
    }

    files.push(relativePath);
  }

  return files;
}

export function createLocalFileStorage(rootDirectory: string): ZelavisFileStorage {
  const rootPath = resolve(rootDirectory);

  function resolvePath(path: string): string {
    return join(rootPath, normalizeStoragePath(path));
  }

  function resolveMetadataPath(path: string): string {
    return `${resolvePath(path)}${STORAGE_METADATA_SUFFIX}`;
  }

  async function readStoredMetadata(path: string): Promise<{
    contentType?: string;
    metadata?: Record<string, string>;
    checksum?: string;
  }> {
    try {
      const raw = await readFile(resolveMetadataPath(path), "utf8");
      const parsed = JSON.parse(raw) as {
        contentType?: unknown;
        metadata?: unknown;
        checksum?: unknown;
      };

      return {
        contentType:
          typeof parsed.contentType === "string" ? parsed.contentType : undefined,
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
      metadata?: Record<string, string>;
      checksum?: string;
    },
  ): Promise<void> {
    const metadataPath = resolveMetadataPath(path);

    if (!value.contentType && !value.metadata && !value.checksum) {
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
          metadata: stored.metadata,
          checksum: stored.checksum,
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

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      await writeStoredMetadata(normalized, {
        contentType: input.contentType,
        metadata: input.metadata,
        checksum: input.metadata?.["checksum-sha256"],
      });

      const info = await stat(filePath);

      return {
        path: normalized,
        size: info.size,
        updatedAt: info.mtime,
        contentType: input.contentType,
        metadata: input.metadata,
        checksum: input.metadata?.["checksum-sha256"],
      };
    },
    async delete(path) {
      try {
        await Promise.all([
          rm(resolvePath(path)),
          rm(resolveMetadataPath(path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }),
        ]);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }

        throw error;
      }
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
