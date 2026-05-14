import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisFileStorage,
  type ZelavisFileStorageEntry,
  type ZelavisFileStorageObject,
  type ZelavisFileStoragePutInput,
  type ZelavisKeyValueStore,
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
    cacheControl?: string;
    contentDisposition?: string;
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
        cacheControl?: string;
        contentDisposition?: string;
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
        cacheControl?: string;
        contentDisposition?: string;
      };
      customMetadata?: Record<string, string>;
    }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface CloudflarePlatformOptions {
  env: CloudflarePlatformEnv;
  bindings?: CloudflarePlatformBindingNames;
  defaultTenantId?: string;
  metadata?: Record<string, unknown>;
}

export interface CloudflarePlatformEnv {
  ZELAVIS_DB?: CloudflareD1Binding;
  ZELAVIS_KV?: CloudflareKvNamespace;
  ZELAVIS_FILES?: CloudflareR2Bucket;
  [key: string]: unknown;
}

export interface CloudflarePlatformBindingNames {
  database?: string;
  kv?: string;
  files?: string;
}

const DEFAULT_CLOUDFLARE_BINDING_NAMES = Object.freeze({
  database: "ZELAVIS_DB",
  kv: "ZELAVIS_KV",
  files: "ZELAVIS_FILES",
});

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
        cacheControl: object.httpMetadata?.cacheControl,
        contentDisposition: object.httpMetadata?.contentDisposition,
        metadata: object.customMetadata,
      };
    },
    async put(input): Promise<ZelavisFileStorageEntry> {
      const bytes = await toBytes(input.body);

      await bucket.put(input.path, bytes, {
        httpMetadata: {
          contentType: input.contentType,
          cacheControl: input.cacheControl,
          contentDisposition: input.contentDisposition,
        },
        customMetadata: input.metadata,
      });

      return {
        path: input.path,
        size: bytes.byteLength,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        contentDisposition: input.contentDisposition,
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
            cacheControl: object.httpMetadata?.cacheControl,
            contentDisposition: object.httpMetadata?.contentDisposition,
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

function isD1Binding(value: unknown): value is CloudflareD1Binding {
  return (
    typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof value.prepare === "function" &&
    "batch" in value &&
    typeof value.batch === "function"
  );
}

function isKvNamespace(value: unknown): value is CloudflareKvNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "put" in value &&
    typeof value.put === "function" &&
    "delete" in value &&
    typeof value.delete === "function" &&
    "list" in value &&
    typeof value.list === "function"
  );
}

function isR2Bucket(value: unknown): value is CloudflareR2Bucket {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "put" in value &&
    typeof value.put === "function" &&
    "delete" in value &&
    typeof value.delete === "function" &&
    "list" in value &&
    typeof value.list === "function"
  );
}

function getBindingName(
  bindings: CloudflarePlatformBindingNames | undefined,
  key: keyof CloudflarePlatformBindingNames,
): string {
  return bindings?.[key] ?? DEFAULT_CLOUDFLARE_BINDING_NAMES[key];
}

function readBinding(
  env: CloudflarePlatformEnv | undefined,
  name: string,
): unknown {
  if (!env) {
    return undefined;
  }

  return env[name];
}

function resolveDatabaseBinding(
  options: CloudflarePlatformOptions,
): CloudflareD1Binding {
  const bindingName = getBindingName(options.bindings, "database");
  const binding = readBinding(options.env, bindingName);

  if (!isD1Binding(binding)) {
    throw new TypeError(
      `Missing or invalid Cloudflare D1 binding \`${bindingName}\`. Pass \`cloudflarePlatform({ env })\` with a valid D1 binding or override the binding name through \`bindings.database\`.`,
    );
  }

  return binding;
}

function resolveKvOption(
  options: CloudflarePlatformOptions,
): { namespace: CloudflareKvNamespace } | undefined {
  const namespace = readBinding(
    options.env,
    getBindingName(options.bindings, "kv"),
  );

  return isKvNamespace(namespace)
    ? {
        namespace,
      }
    : undefined;
}

function resolveFilesOption(
  options: CloudflarePlatformOptions,
): { bucket: CloudflareR2Bucket } | undefined {
  const bucket = readBinding(
    options.env,
    getBindingName(options.bindings, "files"),
  );

  return isR2Bucket(bucket)
    ? {
        bucket,
      }
    : undefined;
}

export function cloudflarePlatform(options: CloudflarePlatformOptions) {
  return defineAdapter({
    name: "cloudflare",
    platform: async (
      _constructorOptions: ZelavisOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> => {
      const nextCoreServices: Record<string, unknown> = {};
      const databaseBinding = resolveDatabaseBinding(options);
      const kvOptions = resolveKvOption(options);
      const filesOptions = resolveFilesOption(options);

      {
        const { createCloudflareD1DatabaseDriver } = await import(
          "@zelavis/database-cloudflare-d1"
        );
        nextCoreServices.database = {
          defaultTenantId: options.defaultTenantId,
          driver: createCloudflareD1DatabaseDriver({
            database: databaseBinding,
          }),
        };
      }

      return {
        coreServices: nextCoreServices,
        resources: {
          kv: kvOptions ? createCloudflareKeyValueStore(kvOptions.namespace) : undefined,
          files: filesOptions
            ? createCloudflareFileStorage(filesOptions.bucket)
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
