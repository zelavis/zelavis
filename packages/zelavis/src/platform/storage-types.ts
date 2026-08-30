/**
 * Platform file-storage contracts.
 *
 * Kept free of runtime imports so storage adapters, the bundle store, and the
 * storage core service can all depend on the shapes without depending on the
 * Platform composition they are used by.
 */

export interface ZelavisFileStoragePutInput {
  path: string;
  body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
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

export type ZelavisStorageCoreServiceInput =
  | boolean
  | ZelavisStorageCoreServiceOptions;
