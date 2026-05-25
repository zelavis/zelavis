/**
 * Shared service package infrastructure for local JS runtimes (Node.js, Bun).
 *
 * All APIs here depend only on standard node: built-ins that are available
 * identically in both Node.js and Bun — no runtime-specific imports.
 */
import {
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ZelavisServiceLoadOptions,
  ZelavisServicePackageInstaller,
} from "../index.js";

// ---------------------------------------------------------------------------
// Shared service directory helpers
// ---------------------------------------------------------------------------

export function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

// ---------------------------------------------------------------------------
// Specifier type detection
// ---------------------------------------------------------------------------

function isRemoteSpecifier(specifier: string): boolean {
  return specifier.startsWith("https://") || specifier.startsWith("http://");
}

function isDataSpecifier(specifier: string): boolean {
  return specifier.startsWith("data:");
}

function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith("file:");
}

function looksLikePathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

// ---------------------------------------------------------------------------
// ZIP parser (no Node-specific deps — inflateRawSync is in Bun too)
// ---------------------------------------------------------------------------

interface ZipEntry {
  path: string;
  body: Uint8Array;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 0xffff - 22);

  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("Service package is not a valid ZIP archive.");
}

function normalizeZipEntryPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");

  if (
    !normalized ||
    normalized.endsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized === ".."
  ) {
    return undefined;
  }

  return normalized;
}

function inflateZipEntry(
  bytes: Uint8Array,
  method: number,
  compressedSize: number,
  localHeaderOffset: number,
): Uint8Array {
  if (readUInt32(bytes, localHeaderOffset) !== 0x04034b50) {
    throw new Error("Service package contains an invalid ZIP local header.");
  }

  const fileNameLength = readUInt16(bytes, localHeaderOffset + 26);
  const extraLength = readUInt16(bytes, localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);

  if (method === 0) {
    return new Uint8Array(compressed);
  }

  if (method === 8) {
    return new Uint8Array(inflateRawSync(compressed));
  }

  throw new Error(`Unsupported ZIP compression method ${method}.`);
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUInt16(bytes, endOffset + 10);
  const centralDirectoryOffset = readUInt32(bytes, endOffset + 16);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50) {
      throw new Error("Service package contains an invalid ZIP central directory.");
    }

    const method = readUInt16(bytes, offset + 10);
    const compressedSize = readUInt32(bytes, offset + 20);
    const fileNameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    const rawPath = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + fileNameLength),
    );
    const path = normalizeZipEntryPath(rawPath);

    if (path) {
      entries.push({
        path,
        body: inflateZipEntry(bytes, method, compressedSize, localHeaderOffset),
      });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function resolveServicePackageEntry(entries: readonly ZipEntry[]): string {
  const manifest = entries.find((entry) => entry.path === "zelavis.service.json");

  if (!manifest) {
    throw new Error("Service package must include zelavis.service.json.");
  }

  const parsed = JSON.parse(new TextDecoder().decode(manifest.body)) as {
    entry?: unknown;
  };
  const entry = typeof parsed.entry === "string" ? parsed.entry.trim() : "";
  const normalized = normalizeZipEntryPath(entry.replace(/^\.\//, ""));

  if (!normalized) {
    throw new Error("Service package manifest must include a valid entry path.");
  }

  if (!entries.some((candidate) => candidate.path === normalized)) {
    throw new Error(`Service package entry "${normalized}" does not exist.`);
  }

  return normalized;
}

function resolvePackageFilePath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);

  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error(`Service package path "${path}" escapes the package root.`);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// ESM import with mtime-based cache busting
// ---------------------------------------------------------------------------

async function importFilePath(filePath: string) {
  const resolvedPath = resolve(filePath);
  const fileStat = await stat(resolvedPath);
  return import(`${pathToFileURL(resolvedPath).href}?mtime=${fileStat.mtimeMs}`);
}

// ---------------------------------------------------------------------------
// Remote service download (https:// specifiers)
// ---------------------------------------------------------------------------

async function downloadRemoteService(
  specifier: string,
  serviceDirectory: string,
): Promise<string> {
  const response = await fetch(specifier);

  if (!response.ok) {
    throw new Error(
      `Failed to download service module from ${specifier}: ${response.status}`,
    );
  }

  const source = await response.text();
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const specifierHash = createHash("sha256").update(specifier).digest("hex");
  const servicePath = join(serviceDirectory, specifierHash, `${sourceHash}.mjs`);

  await writeFile(servicePath, source, { flag: "wx" }).catch(async (error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      mkdirSync(dirname(servicePath), { recursive: true });
      await writeFile(servicePath, source, { flag: "wx" }).catch((nextError) => {
        if (
          typeof nextError === "object" &&
          nextError !== null &&
          "code" in nextError &&
          nextError.code === "EEXIST"
        ) {
          return;
        }
        throw nextError;
      });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }

    throw error;
  });

  return servicePath;
}

// ---------------------------------------------------------------------------
// Public service options interface (shared by node + bun)
// ---------------------------------------------------------------------------

export interface LocalRuntimeServiceOptions {
  directory?: string;
  allowRemote?: boolean;
}

// ---------------------------------------------------------------------------
// Service package installer (ZIP → disk)
// ---------------------------------------------------------------------------

export function createLocalRuntimeServicePackageInstaller(
  options: LocalRuntimeServiceOptions = {},
): ZelavisServicePackageInstaller {
  const serviceDirectory = resolve(options.directory ?? ".zelavis/services");

  return {
    async install(input) {
      const fileName = input.fileName.toLowerCase();

      if (!fileName.endsWith(".zip")) {
        throw new Error("Service package uploads must be ZIP archives.");
      }

      const packageHash = createHash("sha256").update(input.body).digest("hex");
      const entries = readZipEntries(input.body);
      const entry = resolveServicePackageEntry(entries);
      const packageDirectory = join(serviceDirectory, "packages", packageHash);
      const temporaryDirectory = join(
        serviceDirectory,
        ".tmp",
        `${packageHash}-${Date.now()}`,
      );

      if (!existsSync(packageDirectory)) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        await mkdir(temporaryDirectory, { recursive: true });

        try {
          for (const zipEntry of entries) {
            const filePath = resolvePackageFilePath(
              temporaryDirectory,
              zipEntry.path,
            );

            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, zipEntry.body);
          }

          await mkdir(dirname(packageDirectory), { recursive: true });
          renameSync(temporaryDirectory, packageDirectory);
        } catch (error) {
          await rm(temporaryDirectory, { recursive: true, force: true });

          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ) {
            // Another install completed the same package first.
          } else {
            throw error;
          }
        }
      }

      return {
        specifier: join(packageDirectory, entry),
        message: `Installed service package ${input.fileName}.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Service importer (specifier → ESM module)
// ---------------------------------------------------------------------------

export function createLocalRuntimeServiceImporter(
  options: LocalRuntimeServiceOptions = {},
): NonNullable<ZelavisServiceLoadOptions["importer"]> {
  const serviceDirectory = resolve(options.directory ?? ".zelavis/services");
  const allowRemote = options.allowRemote ?? true;

  return async (specifier) => {
    if (isDataSpecifier(specifier)) {
      return import(specifier);
    }

    if (isRemoteSpecifier(specifier)) {
      if (!allowRemote) {
        throw new Error("Remote service module specifiers are disabled.");
      }

      return importFilePath(
        await downloadRemoteService(specifier, serviceDirectory),
      );
    }

    if (isFileSpecifier(specifier)) {
      return import(specifier);
    }

    if (looksLikePathSpecifier(specifier)) {
      return importFilePath(specifier);
    }

    return import(specifier);
  };
}
