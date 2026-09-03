/**
 * Platform file storage: object metadata, checksums, file references, and the
 * storage core service routes.
 *
 * Split out of the Platform composition so the storage surface reads as one
 * unit. Contracts live in `storage-types.ts` so adapters can depend on the
 * shapes without reaching this module.
 */
import {
  encodeStoragePath,
  joinPathParts,
  normalizePath,
  normalizePathPart,
  toIsoDate,
  zelavisErrorResponse,
  ZelavisDomainError,
  ZelavisValidationError,
} from "./shared.js";
import type {
  ZelavisFileReference,
  ZelavisFileStorageEntry,
  ZelavisStorageOptions,
} from "./storage-types.js";
import type { ZelavisRuntimeService } from "../core/index.js";

/** Metadata key under which an uploaded object's SHA-256 checksum is stored. */
const STORAGE_CHECKSUM_METADATA_KEY = "checksum-sha256";

function readStorageMetadataHeaders(
  headers: Headers | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!key.toLowerCase().startsWith("x-zelavis-meta-")) {
      return;
    }

    const name = key.slice("x-zelavis-meta-".length).trim();
    if (!name) {
      return;
    }

    metadata[name] = value;
  });

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function readRequestBytes(
  request: Request | undefined,
): Promise<Uint8Array> {
  if (!request) {
    return new Uint8Array();
  }

  const body = await request.arrayBuffer();
  return new Uint8Array(body);
}

async function computeSha256Hex(body: Uint8Array): Promise<string> {
  if (
    typeof crypto === "undefined" ||
    !crypto.subtle ||
    typeof crypto.subtle.digest !== "function"
  ) {
    throw new ZelavisDomainError(
      "This runtime does not support Web Crypto digest operations.",
    );
  }

  const view = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readStorageChecksum(
  entry: Pick<ZelavisFileStorageEntry, "checksum" | "metadata">,
): string | undefined {
  return entry.checksum ?? entry.metadata?.[STORAGE_CHECKSUM_METADATA_KEY];
}

function createStorageMetadata(
  metadata: Record<string, string> | undefined,
  checksum: string,
): Record<string, string> {
  return {
    ...(metadata ?? {}),
    [STORAGE_CHECKSUM_METADATA_KEY]: checksum,
  };
}

export function createFileReference(
  entry: ZelavisFileStorageEntry,
  options: {
    rootPath?: string;
    apiPrefix?: string;
    apiVersion?: string;
  } = {},
): ZelavisFileReference {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.apiPrefix, "/api");
  const apiVersion = normalizePathPart(options.apiVersion ?? "v1");
  const encodedPath = encodeStoragePath(entry.path);
  const href = joinPathParts(
    rootPath,
    apiPrefix,
    apiVersion,
    "storage",
    "files",
    encodedPath,
  );

  return {
    kind: "file",
    path: entry.path,
    href,
    metadataHref: `${href}?format=metadata`,
    size: entry.size,
    updatedAt: toIsoDate(entry.updatedAt),
    contentType: entry.contentType,
    cacheControl: entry.cacheControl,
    contentDisposition: entry.contentDisposition,
    metadata: entry.metadata,
    checksum: readStorageChecksum(entry),
  };
}


export async function resolveStorageCoreService(
  option: ZelavisStorageOptions | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
  },
): Promise<ZelavisRuntimeService<any> | undefined> {
  const storageOption = option ?? false;

  if (storageOption === false) {
    return undefined;
  }

  const options = storageOption === true ? {} : storageOption;
  const storage = options.storage;

  if (!storage) {
    return undefined;
  }

  return {
    name: "@zelavis/storage",
    basePath: "/storage",
    menu: {
      title: "Storage",
      path: "/storage",
      surface: "core",
    },
    service: {
      storage,
    },
    api: {
      v1: [
        {
          id: "storage.files.list",
          method: "GET",
          path: "/files",
          access: { permissions: ["storage.read"] },
          handler: async ({ query }) => {
            try {
              const prefix = query.get("prefix") ?? undefined;
              const files = storage.list ? await storage.list(prefix) : [];
              return {
                status: 200,
                body: {
                  files,
                  references: files.map((file: any) =>
                    createFileReference(file, {
                      rootPath: context.rootPath,
                      apiPrefix: context.apiPrefix,
                      apiVersion: context.apiVersion,
                    }),
                  ),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "storage.files.read",
          method: "GET",
          path: "/files/*path",
          handler: async ({ params, query }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const file = await storage.get(path);
              if (!file) {
                throw new ZelavisValidationError("Storage file not found.");
              }

              if (query.get("format") === "metadata") {
                return {
                  status: 200,
                  body: {
                  file: {
                    path: file.path,
                    size: file.size,
                    updatedAt: toIsoDate(file.updatedAt),
                    contentType: file.contentType,
                    cacheControl: file.cacheControl,
                    contentDisposition: file.contentDisposition,
                    metadata: file.metadata,
                    checksum: readStorageChecksum(file),
                  },
                    reference: createFileReference(file, {
                      rootPath: context.rootPath,
                      apiPrefix: context.apiPrefix,
                      apiVersion: context.apiVersion,
                    }),
                  },
                };
              }

              return {
                status: 200,
                headers: {
                  "content-type":
                    file.contentType ?? "application/octet-stream",
                  ...(file.cacheControl
                    ? { "cache-control": file.cacheControl }
                    : {}),
                  ...(file.contentDisposition
                    ? { "content-disposition": file.contentDisposition }
                    : {}),
                  ...(readStorageChecksum(file)
                    ? {
                        "x-zelavis-checksum-sha256":
                          readStorageChecksum(file) as string,
                      }
                    : {}),
                  ...(file.size !== undefined
                    ? { "content-length": String(file.size) }
                    : {}),
                },
                body: file.body,
              };
            } catch (error) {
              return zelavisErrorResponse(error, 404);
            }
          },
        },
        {
          id: "storage.files.write",
          method: "PUT",
          path: "/files/*path",
          access: { permissions: ["storage.write"] },
          handler: async ({ params, request, requestHeaders }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const body = await readRequestBytes(request);
              const checksum = await computeSha256Hex(body);
              const metadata = createStorageMetadata(
                readStorageMetadataHeaders(requestHeaders),
                checksum,
              );
              const contentType =
                requestHeaders?.get("content-type") ?? undefined;
              const cacheControl =
                requestHeaders?.get("cache-control") ?? undefined;
              const contentDisposition =
                requestHeaders?.get("content-disposition") ?? undefined;
              const storedEntry = await storage.put({
                path,
                body,
                contentType,
                cacheControl,
                contentDisposition,
                metadata,
              });
              const entry: ZelavisFileStorageEntry = {
                ...storedEntry,
                checksum: readStorageChecksum(storedEntry) ?? checksum,
                cacheControl: storedEntry.cacheControl ?? cacheControl,
                contentDisposition:
                  storedEntry.contentDisposition ?? contentDisposition,
                metadata:
                  storedEntry.metadata && storedEntry.metadata !== metadata
                    ? {
                        ...metadata,
                        ...storedEntry.metadata,
                      }
                    : metadata,
              };

              return {
                status: 200,
                body: {
                  file: entry,
                  reference: createFileReference(entry, {
                    rootPath: context.rootPath,
                    apiPrefix: context.apiPrefix,
                    apiVersion: context.apiVersion,
                  }),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "storage.files.delete",
          method: "DELETE",
          path: "/files/*path",
          access: { permissions: ["storage.write"] },
          handler: async ({ params }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const deleted = await storage.delete(path);
              if (!deleted) {
                throw new ZelavisValidationError("Storage file not found.");
              }

              return {
                status: 200,
                body: {
                  deleted: true,
                  path,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 404);
            }
          },
        },
      ],
    },
  };
}

