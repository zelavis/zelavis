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
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePackageExportsEntry,
  validatePluginPackageManifest,
} from "../core/service/manifest.js";
import type {
  ZelavisPackageManifest,
  ZelavisServiceLoadOptions,
  ZelavisServiceManifestResolver,
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

/**
 * True when a path resolves inside the host's managed service directory.
 *
 * Compares resolved paths with a separator-terminated prefix so a sibling
 * directory such as `.zelavis/services-evil` does not match.
 */
function isManagedServicePath(path: string, serviceDirectory: string): boolean {
  const resolved = resolve(path);
  const root = resolve(serviceDirectory);
  return resolved === root || resolved.startsWith(`${root}${sep}`);
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

/**
 * Bounds on service package extraction.
 *
 * A ZIP declares its own sizes, so an archive can claim to expand to far more
 * than it occupies. Inflation is synchronous here, which makes an unbounded
 * archive both a memory and an event-loop hazard. Streaming extraction off the
 * event loop is the longer-term fix, tracked in `TODO.md`.
 */
const ZIP_MAX_ENTRIES = 2_000;
const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** Highest expanded:compressed ratio accepted for a single entry. */
const ZIP_MAX_COMPRESSION_RATIO = 200;

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

/**
 * ZIP64 stores real sizes and offsets in an extra field; the 32-bit fields hold
 * `0xffffffff` sentinels. This parser reads only the 32-bit fields, so a ZIP64
 * archive would be misread rather than rejected.
 */
function assertNotZip64(value: number, field: string): void {
  if (value === 0xffffffff || value === 0xffff) {
    throw new Error(
      `Service package uses ZIP64 ${field}, which is not supported.`,
    );
  }
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
    if (compressed.length > ZIP_MAX_ENTRY_BYTES) {
      throw new Error(
        `Service package entry exceeds the ${ZIP_MAX_ENTRY_BYTES} byte limit.`,
      );
    }
    return new Uint8Array(compressed);
  }

  if (method === 8) {
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(compressed, {
        maxOutputLength: ZIP_MAX_ENTRY_BYTES,
      });
    } catch (cause) {
      // zlib reports the ceiling as a Buffer allocation failure; say what it
      // actually means so an operator is not left debugging Node internals.
      throw new Error(
        `Service package entry exceeds the ${ZIP_MAX_ENTRY_BYTES} byte expansion limit.`,
        { cause },
      );
    }
    const expanded = new Uint8Array(inflated);
    // A tiny compressed entry that expands enormously is the classic
    // decompression bomb; reject on ratio as well as absolute size.
    if (
      compressed.length > 0 &&
      expanded.length / compressed.length > ZIP_MAX_COMPRESSION_RATIO
    ) {
      throw new Error(
        `Service package entry exceeds the ${ZIP_MAX_COMPRESSION_RATIO}:1 compression ratio limit.`,
      );
    }
    return expanded;
  }

  throw new Error(`Unsupported ZIP compression method ${method}.`);
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUInt16(bytes, endOffset + 10);
  const centralDirectoryOffset = readUInt32(bytes, endOffset + 16);
  const decoder = new TextDecoder();
  if (entryCount > ZIP_MAX_ENTRIES) {
    throw new Error(
      `Service package declares more than ${ZIP_MAX_ENTRIES} entries.`,
    );
  }

  const entries: ZipEntry[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50) {
      throw new Error("Service package contains an invalid ZIP central directory.");
    }

    const method = readUInt16(bytes, offset + 10);
    const compressedSize = readUInt32(bytes, offset + 20);
    assertNotZip64(compressedSize, "compressed sizes");
    assertNotZip64(readUInt32(bytes, offset + 24), "uncompressed sizes");
    const fileNameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    const rawPath = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + fileNameLength),
    );
    const path = normalizeZipEntryPath(rawPath);

    if (path) {
      // Two entries normalizing to one path would make the extracted result
      // depend on ordering, which is a classic way to smuggle a payload past
      // review of the archive listing.
      if (seenPaths.has(path)) {
        throw new Error(
          `Service package contains a duplicate entry path "${path}".`,
        );
      }
      seenPaths.add(path);

      const body = inflateZipEntry(
        bytes,
        method,
        compressedSize,
        localHeaderOffset,
      );
      totalBytes += body.length;
      if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
        throw new Error(
          `Service package expands beyond the ${ZIP_MAX_TOTAL_BYTES} byte limit.`,
        );
      }

      entries.push({ path, body });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Resolves a service package's ESM entry from its `package.json`.
 *
 * Service and plugin configuration lives in the `package.json` `zelavis`
 * namespace and standard ESM fields, the same as any other npm package. The
 * retired `zelavis.service.json` sidecar is not read.
 *
 * The entry comes from `exports` — the `.` condition, or a bare string — so a
 * package that already works with Node resolution works here unchanged.
 */
function resolveServicePackageEntry(entries: readonly ZipEntry[]): string {
  const manifestEntry = entries.find((entry) => entry.path === "package.json");

  if (!manifestEntry) {
    throw new Error("Service package must include package.json.");
  }

  let manifest: ZelavisPackageManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(manifestEntry.body),
    ) as ZelavisPackageManifest;
  } catch {
    throw new Error("Service package package.json is not valid JSON.");
  }

  validatePluginPackageManifest(manifest);

  const entry = resolvePackageExportsEntry(manifest.exports);
  if (!entry) {
    throw new Error(
      'Service package package.json must declare an ESM entry through "exports".',
    );
  }

  const normalized = normalizeZipEntryPath(entry.replace(/^\.\//, ""));
  if (!normalized) {
    throw new Error("Service package must declare a valid entry path.");
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

/**
 * Where a local host will load service code from.
 *
 * Installing a service is a code-execution-level action: `system.services.manage`
 * runs host code by design, and plugins are not sandboxed. The point of this
 * policy is to make that authority hard to *misuse* — not to pretend it is
 * bounded. Every source is therefore opt-in rather than inferred, and the safe
 * default is the one that only runs code already installed for the host.
 */
export interface LocalRuntimeServiceSourcePolicy {
  /** `https:` service modules. Off by default. */
  https?: boolean;
  /**
   * `http:` service modules. Off by default and separate from `https`: plaintext
   * transport means any network position can substitute the code that runs.
   */
  insecureHttp?: boolean;
  /** `data:` service modules. Development convenience; off by default. */
  data?: boolean;
  /** `file:` URLs and filesystem paths. Development convenience; off by default. */
  filesystem?: boolean;
}

export interface LocalRuntimeServiceOptions {
  directory?: string;
  /**
   * @deprecated Use `sources` instead. `allowRemote: true` enables `https` only;
   * plaintext `http:` now requires `sources.insecureHttp`.
   */
  allowRemote?: boolean;
  sources?: LocalRuntimeServiceSourcePolicy;
}

/**
 * Resolves the effective source policy.
 *
 * Remote loading now defaults to off. It previously defaulted to on, and
 * `allowRemote` covered plaintext HTTP as well as HTTPS while leaving `data:`
 * and arbitrary filesystem paths ungated entirely.
 */
function resolveSourcePolicy(
  options: LocalRuntimeServiceOptions,
): Required<LocalRuntimeServiceSourcePolicy> {
  const sources = options.sources ?? {};
  return {
    https: sources.https ?? options.allowRemote ?? false,
    insecureHttp: sources.insecureHttp ?? false,
    data: sources.data ?? false,
    filesystem: sources.filesystem ?? false,
  };
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
        `${packageHash}-${randomUUID()}`,
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
  const sources = resolveSourcePolicy(options);

  const refuse = (kind: string, setting: string): never => {
    throw new Error(
      `${kind} service module specifiers are disabled. Enable them explicitly with services.sources.${setting} if this host should execute code from that source.`,
    );
  };

  return async (specifier) => {
    if (isDataSpecifier(specifier)) {
      if (!sources.data) refuse("data:", "data");
      return import(specifier);
    }

    if (isRemoteSpecifier(specifier)) {
      if (specifier.startsWith("http://")) {
        // Plaintext transport means any network position can substitute the
        // code that runs, so it is gated separately from HTTPS.
        if (!sources.insecureHttp) refuse("Plaintext http:", "insecureHttp");
      } else if (!sources.https) {
        refuse("Remote https:", "https");
      }

      return importFilePath(
        await downloadRemoteService(specifier, serviceDirectory),
      );
    }

    // Code the Platform itself installed into its managed service directory is
    // not an arbitrary filesystem source: it arrived through the permission-
    // gated install path and already lives under host control. Requiring the
    // filesystem policy for it would gate the normal service-install flow
    // behind a setting meant for development convenience.
    if (isFileSpecifier(specifier)) {
      if (!sources.filesystem && !isManagedServicePath(fileURLToPath(specifier), serviceDirectory)) {
        refuse("file:", "filesystem");
      }
      return import(specifier);
    }

    if (looksLikePathSpecifier(specifier)) {
      if (!sources.filesystem && !isManagedServicePath(specifier, serviceDirectory)) {
        refuse("Filesystem path", "filesystem");
      }
      return importFilePath(specifier);
    }

    // A bare package specifier resolves through the host's own installed
    // dependencies, which is the same trust as the host's own code.
    return import(specifier);
  };
}

// ---------------------------------------------------------------------------
// Service manifest resolver (specifier → package.json)
// ---------------------------------------------------------------------------

/**
 * Resolves the `package.json` manifest that sits beside a local service
 * specifier. This lives in the local-runtime adapter, not the runtime core,
 * because filesystem plugin scanning is an explicit core non-goal.
 */
export function createLocalRuntimeServiceManifestResolver(): ZelavisServiceManifestResolver {
  return async (specifier) => {
    if (isRemoteSpecifier(specifier) || isDataSpecifier(specifier)) {
      return undefined;
    }

    const candidatePath = specifier.startsWith("file://")
      ? fileURLToPath(specifier)
      : specifier;

    try {
      const entry = await stat(candidatePath);
      const manifestPath = entry.isDirectory()
        ? join(candidatePath, "package.json")
        : join(dirname(candidatePath), "package.json");
      return JSON.parse(
        await readFile(manifestPath, "utf-8"),
      ) as ZelavisPackageManifest;
    } catch {
      // Not a local filesystem path, or it has no adjacent package.json.
      return undefined;
    }
  };
}
