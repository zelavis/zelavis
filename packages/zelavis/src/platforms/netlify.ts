import {
  createPlatform,
  type ZelavisConstructorOptions,
  type ZelavisFileStorage,
  type ZelavisFileStorageEntry,
  type ZelavisFileStorageObject,
  type ZelavisFileStoragePutInput,
  type ZelavisKeyValueStore,
  type ZelavisPlatformPreset,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";

export interface NetlifyBlobsListResult {
  blobs: ReadonlyArray<{
    key: string;
    size?: number;
    modifiedAt?: Date;
    metadata?: Record<string, string>;
  }>;
  cursor?: string;
  hasMore?: boolean;
}

export interface NetlifyBlobsStore {
  get(
    key: string,
    options?:
      | { type?: "text" }
      | { type: "arrayBuffer" }
      | { type: "stream" },
  ): Promise<string | ArrayBuffer | ReadableStream<Uint8Array> | null>;
  set(
    key: string,
    value: string | Uint8Array | ArrayBuffer | Blob,
    options?: {
      metadata?: Record<string, string>;
      contentType?: string;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<NetlifyBlobsListResult>;
}

async function toBytes(
  body: string | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("getReader" in body) ||
    typeof body.getReader !== "function"
  ) {
    throw new TypeError("Unsupported Netlify Blobs body input.");
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

async function normalizePutBody(
  body: ZelavisFileStoragePutInput["body"],
): Promise<string | Uint8Array | ArrayBuffer | Blob> {
  if (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && body instanceof Blob)
  ) {
    return body;
  }

  const bytes = await toBytes(body);
  return bytes;
}

export function createNetlifyBlobsKeyValueStore(
  store: NetlifyBlobsStore,
): ZelavisKeyValueStore {
  return {
    async get(key) {
      const value = await store.get(key, { type: "text" });
      return typeof value === "string" ? value : undefined;
    },
    async set(key, value) {
      await store.set(key, value, {
        contentType: "text/plain; charset=utf-8",
      });
    },
    async delete(key) {
      const existing = await store.get(key, { type: "text" });
      if (existing === null) {
        return false;
      }

      await store.delete(key);
      return true;
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await store.list({ prefix, cursor });
        keys.push(...response.blobs.map((blob) => blob.key));

        if (!response.hasMore) {
          break;
        }

        cursor = response.cursor;
      }

      return keys.sort((left, right) => left.localeCompare(right));
    },
  };
}

export function createNetlifyBlobsFileStorage(
  store: NetlifyBlobsStore,
): ZelavisFileStorage {
  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      const [body, entries] = await Promise.all([
        store.get(path, { type: "arrayBuffer" }),
        store.list({ prefix: path }),
      ]);

      if (body === null) {
        return undefined;
      }

      const metadata = entries.blobs.find((entry) => entry.key === path);

      return {
        path,
        body: await toBytes(body),
        size: metadata?.size,
        updatedAt: metadata?.modifiedAt,
        metadata: metadata?.metadata,
      };
    },
    async put(input): Promise<ZelavisFileStorageEntry> {
      const body = await normalizePutBody(input.body);
      await store.set(input.path, body, {
        metadata: input.metadata,
        contentType: input.contentType,
      });

      const listed = await store.list({ prefix: input.path });
      const metadata = listed.blobs.find((entry) => entry.key === input.path);

      return {
        path: input.path,
        size: metadata?.size,
        updatedAt: metadata?.modifiedAt,
        contentType: input.contentType,
        metadata: input.metadata,
      };
    },
    async delete(path) {
      const existing = await store.get(path, { type: "arrayBuffer" });
      if (existing === null) {
        return false;
      }

      await store.delete(path);
      return true;
    },
    async list(prefix) {
      const entries: ZelavisFileStorageEntry[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await store.list({ prefix, cursor });
        entries.push(
          ...response.blobs.map((blob) => ({
            path: blob.key,
            size: blob.size,
            updatedAt: blob.modifiedAt,
            metadata: blob.metadata,
          })),
        );

        if (!response.hasMore) {
          break;
        }

        cursor = response.cursor;
      }

      return entries.sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}

export interface NetlifyPlatformOptions {
  database?: false | unknown;
  kv?: false | {
    store?: ZelavisKeyValueStore;
    blobsStore?: NetlifyBlobsStore;
  };
  files?: false | {
    storage?: ZelavisFileStorage;
    blobsStore?: NetlifyBlobsStore;
  };
  metadata?: Record<string, unknown>;
}

export function netlifyPlatform(
  options: NetlifyPlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "netlify",
    async resolve(
      constructorOptions: ZelavisConstructorOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const nextCoreServices: Record<string, unknown> = {};

      if (
        constructorOptions.coreServices?.database !== false &&
        options.database !== false &&
        options.database !== undefined
      ) {
        nextCoreServices.database = options.database as Record<string, unknown>;
      }

      return {
        coreServices: nextCoreServices,
        resources: {
          kv: options.kv
            ? options.kv.store ??
              (options.kv.blobsStore
                ? createNetlifyBlobsKeyValueStore(options.kv.blobsStore)
                : undefined)
            : undefined,
          files: options.files
            ? options.files.storage ??
              (options.files.blobsStore
                ? createNetlifyBlobsFileStorage(options.files.blobsStore)
                : undefined)
            : undefined,
        },
        metadata: {
          runtime: "netlify",
          ...(options.metadata ?? {}),
        },
      };
    },
  });
}
