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

export interface CloudflareKvNamespace {
  get(
    key: string,
    type?: "text",
  ): Promise<string | null>;
  put(
    key: string,
    value: string,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

interface CloudflareD1PreparedStatement {
  bind(...values: unknown[]): CloudflareD1PreparedStatement;
  all<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<{
    results?: T[];
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
  run(): Promise<{
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
}

export interface CloudflareD1Binding {
  prepare(statement: string): CloudflareD1PreparedStatement;
  batch<T = unknown>(statements: readonly unknown[]): Promise<T[]>;
}

export interface CloudflareR2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CloudflareR2Object {
  size: number;
  uploaded: Date;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
  body: CloudflareR2ObjectBody;
}

export interface CloudflareR2Bucket {
  get(key: string): Promise<CloudflareR2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{
    objects: Array<{
      key: string;
      size: number;
      uploaded: Date;
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface CloudflarePlatformOptions {
  database?: false | {
    binding: CloudflareD1Binding;
    defaultTenantId?: string;
  };
  kv?: false | {
    namespace: CloudflareKvNamespace;
  };
  files?: false | {
    bucket: CloudflareR2Bucket;
  };
  metadata?: Record<string, unknown>;
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

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("getReader" in body) ||
    typeof body.getReader !== "function"
  ) {
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

function createCloudflareKeyValueStore(
  namespace: CloudflareKvNamespace,
): ZelavisKeyValueStore {
  return {
    async get(key) {
      return (await namespace.get(key, "text")) ?? undefined;
    },
    async set(key, value) {
      await namespace.put(key, value);
    },
    async delete(key) {
      const existing = await namespace.get(key, "text");
      if (existing === null) {
        return false;
      }
      await namespace.delete(key);
      return true;
    },
    async list(prefix) {
      const results: string[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await namespace.list({ prefix, cursor });
        results.push(...response.keys.map((entry) => entry.name));
        if (response.list_complete) {
          break;
        }
        cursor = response.cursor;
      }

      return results.sort((left, right) => left.localeCompare(right));
    },
  };
}

function createCloudflareFileStorage(bucket: CloudflareR2Bucket): ZelavisFileStorage {
  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      const object = await bucket.get(path);
      if (!object) {
        return undefined;
      }

      return {
        path,
        body: new Uint8Array(await object.body.arrayBuffer()),
        size: object.size,
        updatedAt: object.uploaded,
        contentType: object.httpMetadata?.contentType,
        metadata: object.customMetadata,
      };
    },
    async put(input): Promise<ZelavisFileStorageEntry> {
      const bytes = await toBytes(input.body);

      await bucket.put(input.path, bytes, {
        httpMetadata: {
          contentType: input.contentType,
        },
        customMetadata: input.metadata,
      });

      return {
        path: input.path,
        size: bytes.byteLength,
        contentType: input.contentType,
        metadata: input.metadata,
      };
    },
    async delete(path) {
      const existing = await bucket.get(path);
      if (!existing) {
        return false;
      }
      await bucket.delete(path);
      return true;
    },
    async list(prefix) {
      const results: ZelavisFileStorageEntry[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await bucket.list({ prefix, cursor });
        results.push(
          ...response.objects.map((object) => ({
            path: object.key,
            size: object.size,
            updatedAt: object.uploaded,
            contentType: object.httpMetadata?.contentType,
            metadata: object.customMetadata,
          })),
        );

        if (!response.truncated) {
          break;
        }

        cursor = response.cursor;
      }

      return results.sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeExisting(
  existing: unknown,
  next: Record<string, unknown>,
): unknown {
  if (existing === undefined || existing === true) {
    return next;
  }

  if (isObject(existing)) {
    return {
      ...next,
      ...existing,
    };
  }

  return existing;
}

export function cloudflarePlatform(
  options: CloudflarePlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "cloudflare",
    async resolve(
      constructorOptions: ZelavisConstructorOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const nextCoreServices: Record<string, unknown> = {};

      if (
        constructorOptions.coreServices?.database !== false &&
        options.database !== false &&
        options.database
      ) {
        const { createCloudflareD1DatabaseDriver } = await import(
          "@zelavis/database-cloudflare-d1"
        );
        nextCoreServices.database = mergeExisting(
          constructorOptions.coreServices?.database,
          {
            defaultTenantId: options.database.defaultTenantId,
            driver: createCloudflareD1DatabaseDriver({
              database: options.database.binding,
            }),
          },
        );
      }

      return {
        coreServices: nextCoreServices,
        resources: {
          kv: options.kv ? createCloudflareKeyValueStore(options.kv.namespace) : undefined,
          files: options.files
            ? createCloudflareFileStorage(options.files.bucket)
            : undefined,
        },
        metadata: {
          runtime: "cloudflare",
          ...(options.metadata ?? {}),
        },
      };
    },
  });
}
