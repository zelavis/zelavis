/**
 * Platform file-storage contracts.
 *
 * Kept free of runtime imports so storage adapters, the bundle store, and the
 * storage core service can all depend on the shapes without depending on the
 * Platform composition they are used by.
 */

/**
 * A precondition on a write, checked by the store in the same step as the
 * write. `ifAbsent` creates only where nothing is stored; `ifMatch` replaces
 * only the version whose `etag` the caller read.
 *
 * Leases, fencing and anything published as authoritative rest on these. A
 * store that cannot enforce a condition must refuse the write rather than
 * perform it unconditionally, and `probeFileStorageGuarantees` checks, against
 * the store itself, that it does.
 */
export type ZelavisFileStorageCondition =
  | { readonly ifAbsent: true }
  | { readonly ifMatch: string };

export interface ZelavisFileStoragePutInput {
  path: string;
  body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  /** Write only if this holds; a condition that fails writes nothing. */
  condition?: ZelavisFileStorageCondition;
}

export interface ZelavisFileStorageEntry {
  path: string;
  size?: number;
  updatedAt?: Date;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
  /** An opaque version of the stored bytes; pass it back as `ifMatch`. */
  etag?: string;
}

export interface ZelavisFileStorageObject extends ZelavisFileStorageEntry {
  body: Uint8Array;
}

export interface ZelavisFileReference {
  kind: "file";
  path: string;
  href: string;
  metadataHref: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

export interface ZelavisFileStorage {
  get(
    path: string,
  ):
    | Promise<ZelavisFileStorageObject | undefined>
    | ZelavisFileStorageObject
    | undefined;
  put(
    input: ZelavisFileStoragePutInput,
  ):
    | Promise<ZelavisFileStorageEntry>
    | ZelavisFileStorageEntry;
  delete(path: string): Promise<boolean> | boolean;
  list?(
    prefix?: string,
  ): Promise<readonly ZelavisFileStorageEntry[]> | readonly ZelavisFileStorageEntry[];
}

export interface ZelavisStorageCoreServiceOptions {
  storage?: ZelavisFileStorage;
}

export type ZelavisStorageOptions =
  | boolean
  | ZelavisStorageCoreServiceOptions;
