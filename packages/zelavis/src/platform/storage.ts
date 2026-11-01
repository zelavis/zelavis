import { Cause, Effect } from "effect";
import { createS3CompatibleFileStorage } from "../storage/s3.js";
import { checkUserPath, RESERVED_PREFIX, storageControls } from "./storage-uploads.js";
import { present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
/**
 * Platform file storage: object metadata, checksums, file references, and the
 * storage subsystem routes.
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
  ZelavisFileStorage,
  ZelavisFileStorageEntry,
  ZelavisStorageOptions,
} from "./storage-types.js";
import type { ZelavisEndpointGroup } from "../core/index.js";

/** Metadata key under which an uploaded object's SHA-256 checksum is stored. */
const STORAGE_CHECKSUM_METADATA_KEY = "checksum-sha256";

/**
 * Header prefixes an upload's metadata travels under. `x-zelavis-meta-` is the canonical one; the Project Gateway
 * removes every `x-zelavis-*` request header (a caller cannot claim Platform authority), so a client that
 * reaches a Project through the Platform, as the dashboard does, uses `x-file-meta-`.
 */
const STORAGE_METADATA_HEADER_PREFIXES = ["x-zelavis-meta-", "x-file-meta-"] as const;

export function readStorageMetadataHeaders(
  headers: Headers | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    const prefix = STORAGE_METADATA_HEADER_PREFIXES.find((entry) => lower.startsWith(entry));
    if (!prefix) {
      return;
    }

    const name = lower.slice(prefix.length).trim();
    if (!name) {
      return;
    }

    metadata[name] = value;
  });

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readRequestBytes(
  request: Request | undefined,
): Promise<Uint8Array> {
    return present(Effect.gen(function* (): Effect.fn.Return<Uint8Array, IntegrationFailure> {
  if (!request) {
    return new Uint8Array();
  }

  const body = (yield* integrationValue(request.arrayBuffer()));
  return new Uint8Array(body);
}));
  }

function computeSha256Hex(body: Uint8Array): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
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
  const digest = (yield* integrationValue(crypto.subtle.digest("SHA-256", view)));
  return (yield* integrationValue([...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")));
}));
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

/**
 * Copy up to `limit` files under `prefix` (after `after`, in path order) from one storage into another under
 * `into`, skipping a file already there with the same SHA-256. Answers `next` while more remain.
 */
export function copyStorageFiles(
  from: ZelavisFileStorage,
  to: ZelavisFileStorage,
  options: { readonly prefix?: string; readonly into: string; readonly after?: string; readonly limit: number; readonly origin: string },
): Promise<{ readonly copied: number; readonly skipped: number; readonly bytes: number; readonly next?: string }> {
  return present(Effect.gen(function* () {
    if (from.list === undefined) throw new ZelavisValidationError("The import source cannot list its files.");
    const listed = [...(yield* integration(() => Promise.resolve(from.list!(options.prefix))))]
      .map((entry) => entry.path).filter((path) => options.after === undefined || path > options.after).sort();
    const page = listed.slice(0, options.limit);
    let copied = 0, skipped = 0, bytes = 0;
    for (const path of page) {
      const object = yield* integration(() => Promise.resolve(from.get(path)));
      if (object === undefined) continue;
      const checksum = yield* integration(() => computeSha256Hex(object.body));
      const target = options.into === "" ? path : `${options.into}/${path}`;
      const held = yield* integration(() => Promise.resolve(to.get(target)));
      if (held !== undefined && readStorageChecksum(held) === checksum) { skipped += 1; continue; }
      yield* integration(() => Promise.resolve(to.put({
        path: target, body: object.body,
        ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        metadata: createStorageMetadata({ "imported-from": `${options.origin}/${path}` }, checksum),
      })));
      copied += 1;
      bytes += object.body.byteLength;
    }
    return { copied, skipped, bytes, ...(listed.length > options.limit ? { next: page[page.length - 1]! } : {}) };
  }));
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


export function resolveStorageEndpointGroup(
  option: ZelavisStorageOptions | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
  },
): Promise<ZelavisEndpointGroup<any> | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEndpointGroup<any> | undefined, IntegrationFailure> {
  const storageOption = option ?? false;

  if (storageOption === false) {
    return undefined;
  }

  const options = storageOption === true ? {} : storageOption;
  const storage = options.storage;

  if (!storage) {
    return undefined;
  }

  const controls = storageControls(storage);
  const run = <A>(effect: Effect.Effect<A, unknown>) => effect.pipe(
    Effect.map((body) => ({ status: 200, body })),
    Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 400))),
  );
  const object = (body: unknown): Record<string, unknown> => body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};

  return {
    id: "storage",
    basePath: "/storage",
    context: {
      storage,
    },
    origin: { type: "subsystem", subsystem: "storage" },
    api: {
      v1: [
        {
          id: "storage.files.list",
          method: "GET",
          path: "/files",
          access: { permissions: ["storage.read"] },
          handler: ({ query }) => present(Effect.gen(function* () {
                          const prefix = query.get("prefix") ?? undefined;
              const files = (storage.list ? yield* integration(() => storage.list!(prefix)) : []).filter((file) => !file.path.startsWith(RESERVED_PREFIX));
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
            }).pipe(Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
        },
        {
          id: "storage.quota.get", method: "GET", path: "/quota", access: { permissions: ["storage.read"] },
          spec: { operationId: "getStorageQuota", summary: "The storage's quota and usage", tags: ["storage"], responses: { 200: { description: "{ quota: { maxBytes?, maxFileBytes? }, usage: { bytes, files } }" } } },
          handler: () => present(run(Effect.all({ quota: controls.quota, usage: controls.usage }))),
        },
        {
          id: "storage.quota.set", method: "PUT", path: "/quota", access: { permissions: ["storage.manage"] },
          spec: { operationId: "setStorageQuota", summary: "Set the storage's quota", description: "`maxBytes` in all and `maxFileBytes` per file, each optional (absent: no limit). Every later write, import and confirmed upload is held to it.", tags: ["storage"], responses: { 200: { description: "{ quota, usage }" }, 400: { description: "Invalid quota" } } },
          handler: ({ body }) => present(run(controls.setQuota(object(body) as never))),
        },
        {
          id: "storage.uploads.create", method: "POST", path: "/uploads", access: { permissions: ["storage.write"] },
          spec: { operationId: "createStorageUpload", summary: "A signed, single-use upload link", description: "For `{ path, maxBytes, contentType?, expiresInSeconds? }` (at most an hour): a token a browser sends the bytes with (`PUT storage/uploads/:token`, no credentials), refused past the size, with another type, after expiry or a second time. The bytes wait in staging until `confirm`.", tags: ["storage"], responses: { 200: { description: "{ id, path, maxBytes, contentType?, expiresAt, token }" }, 400: { description: "Refused, with the reason" } } },
          handler: ({ body }) => present(run(controls.createUpload(object(body) as never))),
        },
        {
          id: "storage.uploads.receive", method: "PUT", path: "/uploads/:token",
          spec: { operationId: "receiveStorageUpload", summary: "Send a signed upload's bytes", description: "Needs no credentials: the token is the authority, and its terms bind path, size, type and expiry. Single use.", tags: ["storage"], responses: { 200: { description: "{ id, size, sha256 }" }, 400: { description: "Refused, with the reason" } } },
          handler: ({ params, request, requestHeaders }) => present(Effect.gen(function* () {
            const bytes = yield* integration(() => readRequestBytes(request));
            return yield* run(controls.receive(params.token ?? "", bytes, requestHeaders?.get("content-type") ?? undefined));
          })),
        },
        {
          id: "storage.uploads.confirm", method: "POST", path: "/uploads/:id/confirm", access: { permissions: ["storage.write"] },
          spec: { operationId: "confirmStorageUpload", summary: "Make a received upload a file", description: "Checks it against `{ sha256?, size? }` when given, moves it from staging to its path under the quota, and records its SHA-256.", tags: ["storage"], responses: { 200: { description: "{ id, path, size, sha256 }" }, 400: { description: "Refused, with the reason" } } },
          handler: ({ params, body }) => present(run(controls.confirm(params.id ?? "", object(body) as never))),
        },
        {
          id: "storage.uploads.cleanup", method: "POST", path: "/uploads/cleanup", access: { permissions: ["storage.manage"] },
          spec: { operationId: "cleanupStorageUploads", summary: "Remove expired, unconfirmed uploads", tags: ["storage"], responses: { 200: { description: "{ removed }" } } },
          handler: () => present(run(controls.cleanup)),
        },
        {
          id: "storage.import",
          method: "POST",
          path: "/import",
          access: { permissions: ["storage.write"] },
          spec: {
            operationId: "importStorageFiles",
            summary: "Copy files in from another system's S3-compatible bucket",
            description: "Copies up to `limit` (1 to 500) objects under the source `prefix`, after `after`, in path order, into this storage under `into`, and answers `next` while more remain. A file already here with the same SHA-256 is skipped, so a repeated or resumed import copies nothing twice. The source's credentials are used for this call and never kept. Only S3-compatible sources are read (Supabase Storage, MinIO, R2, GCS interoperability); arbitrary URLs are not fetched.",
            tags: ["storage"],
            responses: { 200: { description: "{ copied, skipped, bytes, next? }" }, 400: { description: "Refused, with the reason" } },
          },
          handler: ({ body }) => present(Effect.gen(function* () {
            const input = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
            const source = (input.source !== null && typeof input.source === "object" ? input.source : {}) as Record<string, unknown>;
            if (source.kind !== "s3") throw new ZelavisValidationError('An import source is { kind: "s3", bucket, region, accessKeyId, secretAccessKey, endpoint?, prefix?, forcePathStyle? }.');
            for (const field of ["bucket", "region", "accessKeyId", "secretAccessKey"]) {
              if (typeof source[field] !== "string" || source[field] === "") throw new ZelavisValidationError(`The import source needs ${field}.`);
            }
            const limit = input.limit === undefined ? 100 : Number(input.limit);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ZelavisValidationError("limit is 1 to 500.");
            const into = typeof input.into === "string" ? input.into.replace(/^\/+|\/+$/g, "") : "";
            if (into.startsWith(".zelavis")) throw new ZelavisValidationError("Files cannot be imported under the reserved .zelavis/ prefix.");
            const prefix = typeof source.prefix === "string" ? source.prefix : undefined;
            const after = typeof input.after === "string" ? input.after : undefined;
            const from = createS3CompatibleFileStorage({
              bucket: String(source.bucket), region: String(source.region), accessKeyId: String(source.accessKeyId), secretAccessKey: String(source.secretAccessKey),
              ...(typeof source.endpoint === "string" ? { endpoint: source.endpoint } : {}),
              ...(typeof source.forcePathStyle === "boolean" ? { forcePathStyle: source.forcePathStyle } : {}),
            });
            // Into the same quota as every other write.
            const target: ZelavisFileStorage = { ...storage, put: (put) => present(controls.withinQuota(put.path, put.body instanceof Uint8Array ? put.body.byteLength : 0, integration(() => Promise.resolve(storage.put(put))))) };
            return { status: 200, body: yield* integration(() => copyStorageFiles(from, target, {
              ...(prefix === undefined ? {} : { prefix }), into, ...(after === undefined ? {} : { after }), limit, origin: `s3://${String(source.bucket)}`,
            })) };
          }).pipe(Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
        },
        {
          id: "storage.files.read",
          method: "GET",
          path: "/files/*path",
          handler: ({ params, query }) => present(Effect.gen(function* () {
                          const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              if (path.startsWith(RESERVED_PREFIX)) throw new ZelavisValidationError(`"${path}" is reserved.`);
              const file = yield* integration(() => storage.get(path));
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
            }).pipe(Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 404))))),
        },
        {
          id: "storage.files.write",
          method: "PUT",
          path: "/files/*path",
          access: { permissions: ["storage.write"] },
          handler: ({ params, request, requestHeaders }) => present(Effect.gen(function* () {
                          const path = params.path ?? "";
              checkUserPath(path);
              const body = yield* integration(() => readRequestBytes(request));
              const checksum = yield* integration(() => computeSha256Hex(body));
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
              const storedEntry = yield* controls.withinQuota(path, body.byteLength, integration(() => Promise.resolve(storage.put({
                path,
                body,
                contentType,
                cacheControl,
                contentDisposition,
                metadata,
              }))));
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
            }).pipe(Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
        },
        {
          id: "storage.files.delete",
          method: "DELETE",
          path: "/files/*path",
          access: { permissions: ["storage.write"] },
          handler: ({ params }) => present(Effect.gen(function* () {
                          const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }
              if (path.startsWith(RESERVED_PREFIX)) throw new ZelavisValidationError(`"${path}" is reserved.`);

              const deleted = yield* integration(() => storage.delete(path));
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
            }).pipe(Effect.catchCause((cause) => Effect.succeed(zelavisErrorResponse(unwrapFailure(Cause.squash(cause)), 404))))),
        },
      ],
    },
  };
}));
  }
