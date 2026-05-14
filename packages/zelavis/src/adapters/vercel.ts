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

export interface VercelBlobMetadata {
  pathname: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  size?: number;
  uploadedAt?: Date;
  downloadUrl?: string;
  url?: string;
}

export interface VercelBlobListResult {
  blobs: readonly VercelBlobMetadata[];
  cursor?: string;
  hasMore?: boolean;
}

export interface VercelBlobStore {
  head(pathname: string): Promise<VercelBlobMetadata>;
  put(
    pathname: string,
    body: ZelavisFileStoragePutInput["body"],
    options: {
      access: "private" | "public";
      addRandomSuffix?: boolean;
      allowOverwrite?: boolean;
      contentType?: string;
      cacheControl?: string;
      contentDisposition?: string;
    },
  ): Promise<VercelBlobMetadata>;
  del(pathname: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<VercelBlobListResult>;
}

async function readVercelBlobBytes(
  store: VercelBlobStore,
  metadata: VercelBlobMetadata,
): Promise<Uint8Array | undefined> {
  const targetUrl = metadata.downloadUrl ?? metadata.url;
  if (!targetUrl) {
    return undefined;
  }

  const response = await fetch(targetUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to read Vercel Blob object "${metadata.pathname}" (${response.status}).`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

export function createVercelBlobFileStorage(
  store: VercelBlobStore,
  options: {
    access?: "private" | "public";
    addRandomSuffix?: boolean;
  } = {},
): ZelavisFileStorage {
  const access = options.access ?? "private";
  const addRandomSuffix = options.addRandomSuffix ?? false;

  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      try {
        const metadata = await store.head(path);
        const body = await readVercelBlobBytes(store, metadata);
        if (!body) {
          return undefined;
        }

        return {
          path: metadata.pathname,
          body,
          size: metadata.size,
          updatedAt: metadata.uploadedAt,
          contentType: metadata.contentType,
          cacheControl: metadata.cacheControl,
          contentDisposition: metadata.contentDisposition,
        };
      } catch {
        return undefined;
      }
    },
    async put(input): Promise<ZelavisFileStorageEntry> {
      const metadata = await store.put(input.path, input.body, {
        access,
        addRandomSuffix,
        allowOverwrite: true,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        contentDisposition: input.contentDisposition,
      });

      return {
        path: metadata.pathname,
        size: metadata.size,
        updatedAt: metadata.uploadedAt,
        contentType: metadata.contentType,
        cacheControl: metadata.cacheControl ?? input.cacheControl,
        contentDisposition:
          metadata.contentDisposition ?? input.contentDisposition,
        metadata: input.metadata,
      };
    },
    async delete(path) {
      const existing = await this.get(path);
      if (!existing) {
        return false;
      }

      await store.del(path);
      return true;
    },
    async list(prefix) {
      const entries: ZelavisFileStorageEntry[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await store.list({ prefix, cursor, limit: 1000 });
        entries.push(
          ...response.blobs.map((blob) => ({
            path: blob.pathname,
            size: blob.size,
            updatedAt: blob.uploadedAt,
            contentType: blob.contentType,
            cacheControl: blob.cacheControl,
            contentDisposition: blob.contentDisposition,
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

export interface VercelAdapterOptions {
  database?: false | unknown;
  kv?: false | {
    store: ZelavisKeyValueStore;
  };
  files?: false | {
    storage?: ZelavisFileStorage;
    blobStore?: VercelBlobStore;
    access?: "private" | "public";
    addRandomSuffix?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export function vercelAdapter(options: VercelAdapterOptions = {}) {
  return defineAdapter({
    name: "vercel",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const nextCoreServices: Record<string, unknown> = {};

      if (options.database !== false && options.database !== undefined) {
        nextCoreServices.database = options.database as Record<string, unknown>;
      }

      return {
        coreServices: nextCoreServices,
        resources: {
          kv: options.kv ? options.kv.store : undefined,
          files: options.files
            ? options.files.storage ??
              (options.files.blobStore
                ? createVercelBlobFileStorage(options.files.blobStore, {
                    access: options.files.access,
                    addRandomSuffix: options.files.addRandomSuffix,
                  })
                : undefined)
            : undefined,
        },
        metadata: {
          runtime: "vercel",
          ...(options.metadata ?? {}),
        },
      };
    },
  });
}
