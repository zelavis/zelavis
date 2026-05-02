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

    files.push(relative(root, nextPath).replace(/\\/g, "/"));
  }

  return files;
}

export function createLocalFileStorage(rootDirectory: string): ZelavisFileStorage {
  const rootPath = resolve(rootDirectory);

  function resolvePath(path: string): string {
    return join(rootPath, normalizeStoragePath(path));
  }

  async function createEntry(path: string): Promise<ZelavisFileStorageEntry> {
    const info = await stat(resolvePath(path));

    return {
      path: normalizeStoragePath(path),
      size: info.size,
      updatedAt: info.mtime,
    };
  }

  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      const normalized = normalizeStoragePath(path);
      try {
        const filePath = resolvePath(normalized);
        const [body, info] = await Promise.all([readFile(filePath), stat(filePath)]);

        return {
          path: normalized,
          body: new Uint8Array(body),
          size: info.size,
          updatedAt: info.mtime,
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

      const info = await stat(filePath);

      return {
        path: normalized,
        size: info.size,
        updatedAt: info.mtime,
        contentType: input.contentType,
        metadata: input.metadata,
      };
    },
    async delete(path) {
      try {
        await rm(resolvePath(path));
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
