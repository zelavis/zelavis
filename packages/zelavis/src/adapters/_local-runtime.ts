/**
 * Shared service package infrastructure for local JS runtimes (Node.js, Bun).
 *
 * All APIs here depend only on standard node: built-ins that are available
 * identically in both Node.js and Bun — no runtime-specific imports.
 */
import { provideHostPackagesTo, unprovidedDependencies } from "./_service-resolution.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePackageExportsEntry,
  validatePluginPackageManifest,
} from "../core/service/manifest.js";
import { readFrontendManifest } from "../core/service/frontend.js";
import {
  acquirePackage,
  type PackageEntry,
} from "./_package-acquisition.js";
import {
  readScaffoldOutput,
  resolveCreatePackageBin,
  runCreatePackage,
} from "./_package-scaffold.js";
import type {
  ZelavisServicePackageAcquireInput,
  ZelavisServicePackageScaffoldInput,
  ZelavisServiceRegistryModuleEntry,
} from "../index.js";
import { loadPluginPackage } from "../service.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { createSystemStoreServiceRegistryStore } from "../platform/settings.js";
import { createLocalMarketplace, type LocalMarketplace, type MarketplaceOptions } from "./_marketplace-allowlist.js";
import type {
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "../service.js";
import { Effect } from "effect";
import { ZelavisValidationError } from "../platform/shared.js";
import {
  AcquisitionFailed,
  MaterializationFailed,
  SourceRefused,
  UnusablePackage,
} from "../platform/service-lifecycle-errors.js";
import {
  parsePackageSourceRef,
  ZELAVIS_DEFAULT_NPM_REGISTRY,
  type ZelavisGitSourcePolicy,
  type ZelavisHttpsSourcePolicy,
  type ZelavisNpmSourcePolicy,
  type ZelavisServiceSourcePolicy,
} from "../platform/package-sources.js";
import type {
  ZelavisPackageManifest,
  ZelavisServiceLoadOptions,
  ZelavisServiceManifestResolver,
  ZelavisServicePackageInstaller,
} from "../index.js";
import type { ZelavisFileStorage, ZelavisServicePackageInstaller as LocalServicePackageInstaller, ZelavisServiceRegistryOptions } from "../index.js";
import { createSharedBundleStore } from "../bundle-store.js";
import type { BundleAsset, BundleScope, BundleStore } from "../bundle-store.js";

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
function isPathWithin(path: string, serviceDirectory: string): boolean {
  const resolved = resolve(path);
  const root = resolve(serviceDirectory);
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}

/** Both the named path and its physical target must belong to the managed root. */
function isManagedServicePath(path: string, serviceDirectory: string): boolean {
  try {
    const physicalRoot = realpathSync(serviceDirectory);
    // Discovery imports canonical URLs. Hosts such as macOS expose the same
    // managed root through /var and /private/var, so accept either root name.
    if (!isPathWithin(path, serviceDirectory) && !isPathWithin(path, physicalRoot)) return false;
    return isPathWithin(realpathSync(path), physicalRoot);
  } catch {
    // Missing paths and broken links cannot qualify as host-managed code.
    return false;
  }
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
 * namespace and standard ESM fields, the same as any other npm package.
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
  /**
   * Registries this installation may acquire packages from. Off by default.
   *
   * Distinct from `https` above: that decides whether a module already named by
   * a URL may be executed, this decides whether a package may be downloaded and
   * installed in the first place. An installation can reasonably want one
   * without the other.
   */
  npm?: ZelavisNpmSourcePolicy;
  /** Hosts that may serve package archives directly. Off by default. */
  archives?: ZelavisHttpsSourcePolicy;
  /** Git forges that may be installed from, by pinned commit. Off by default. */
  git?: ZelavisGitSourcePolicy;
}

/** What the installer asks of an allow-list before and after fetching a package. */
export interface LocalAcquisitionGate {
  authorize(input: { name: string; version: string }): Promise<unknown>;
  verifyAcquired(input: { name: string; version: string; integrity: string }): Promise<void>;
}

export interface LocalRuntimeServiceOptions {
  directory?: string;
  /**
   * Further directories whose contents count as host-managed code.
   *
   * The services folder is one: an operator putting a package there is
   * the same deliberate act as installing one, so it is not gated behind the
   * filesystem source policy meant for arbitrary developer paths. It is still
   * an explicit list — nothing outside these roots is trusted.
   */
  managedDirectories?: readonly string[];
  sources?: LocalRuntimeServiceSourcePolicy;
  /**
   * Decides which packages may be installed from a registry. When set, an npm
   * reference must name an exact version the gate vouches for, and what arrives
   * must have the digest it vouches for, or the install is refused. The
   * marketplace allow-list is the gate a host normally supplies; without one,
   * the `sources` policy alone decides.
   */
  acquisitionGate?: LocalAcquisitionGate;
  /** Registry used when a reference does not name one. */
  defaultRegistry?: string;
  /**
   * How long a create package may run while scaffolding a frontend.
   *
   * A create package runs with no network and no ability to spawn anything, so
   * a run that has not finished is stuck rather than slow.
   */
  scaffoldTimeoutMs?: number;
}

/**
 * Resolves which specifier schemes may be executed.
 *
 * Everything defaults to off. The failure mode of default-deny is a service
 * that does not load; the failure mode of default-allow is code from anywhere
 * running with Platform authority.
 */
function resolveSourcePolicy(options: LocalRuntimeServiceOptions) {
  const sources = options.sources ?? {};
  return {
    https: sources.https ?? false,
    insecureHttp: sources.insecureHttp ?? false,
    data: sources.data ?? false,
    filesystem: sources.filesystem ?? false,
  };
}

/**
 * Resolves which remote sources packages may be acquired from.
 *
 * Returns undefined when none are configured, which is what makes acquisition
 * refuse outright rather than fall back to some built-in registry.
 */
function resolveAcquisitionPolicy(
  options: LocalRuntimeServiceOptions,
): ZelavisServiceSourcePolicy | undefined {
  const sources = options.sources ?? {};
  // With a gate, the default registry is reachable without further
  // configuration: the gate, not the registry list, decides what installs.
  const npm = sources.npm ?? (options.acquisitionGate
    ? { registries: [options.defaultRegistry ?? ZELAVIS_DEFAULT_NPM_REGISTRY] }
    : undefined);
  if (!npm && !sources.archives && !sources.git) {
    return undefined;
  }
  return { npm, https: sources.archives, git: sources.git };
}

// ---------------------------------------------------------------------------
// Service package installer (ZIP → disk)
// ---------------------------------------------------------------------------

/**
 * Writes package entries into a content-addressed directory.
 *
 * Content-addressed so the same package installs once no matter how many times
 * or by how many names it arrives, and staged-then-renamed so a crashed install
 * cannot leave a half-written package that looks complete.
 */
/**
 * Writes a package into its content-addressed home, or writes nothing.
 *
 * The temp directory is a scoped resource, so it is removed when the scope
 * closes however that happens — the previous code cleaned up in a `catch`,
 * which covered a throw but not an interruption.
 *
 * Losing the rename to `EEXIST` is success, not failure: another install
 * materialized the same digest first, and the same bytes are already there.
 */
const materializePackage = Effect.fn("materializePackage")(function* (
  serviceDirectory: string,
  packageHash: string,
  entries: readonly PackageEntry[],
  reference: string,
) {
  const packageDirectory = join(serviceDirectory, "packages", packageHash);
  if (existsSync(packageDirectory)) return packageDirectory;

  const temporaryDirectory = yield* Effect.acquireRelease(
    Effect.sync(() => join(serviceDirectory, ".tmp", `${packageHash}-${randomUUID()}`)),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await rm(temporaryDirectory, { recursive: true, force: true });
      await mkdir(temporaryDirectory, { recursive: true });
      for (const entry of entries) {
        const filePath = resolvePackageFilePath(temporaryDirectory, entry.path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, entry.body);
      }
      await mkdir(dirname(packageDirectory), { recursive: true });
      renameSync(temporaryDirectory, packageDirectory);
    },
    catch: (cause) => {
      const raced =
        typeof cause === "object" && cause !== null && "code" in cause
        && (cause as { code?: unknown }).code === "EEXIST";
      return raced
        ? undefined
        : new MaterializationFailed({ reference, cause });
    },
  }).pipe(
    // `undefined` is the raced case: another install won, which is a success.
    Effect.catch((failure) => (failure ? Effect.fail(failure) : Effect.void)),
  );

  return packageDirectory;
});

/**
 * Removes what the registry no longer points at from a services folder.
 *
 * An installed package lives in `packages/<digest>`, so each update leaves the
 * previous version behind and an uninstall leaves the package. Done once, at
 * start, because nothing is loaded then: a folder deleted under a running
 * service would break a lazy import it makes later. `.tmp` holds installs that
 * were interrupted. Anything that cannot be read as a registry is left alone.
 */
export async function pruneServicePackages(options: {
  readonly directory: string;
  readonly referencedSpecifiers: readonly string[];
}): Promise<{ readonly removed: readonly string[] }> {
  const root = resolve(options.directory);
  const packages = join(root, "packages");
  const referenced = new Set<string>();
  for (const specifier of options.referencedSpecifiers) {
    if (!isAbsolute(specifier)) continue;
    const relativePath = relative(packages, specifier);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    const digest = relativePath.split(sep)[0];
    if (digest) referenced.add(digest);
  }

  const removed: string[] = [];
  if (existsSync(packages)) {
    for (const entry of await readdir(packages, { withFileTypes: true })) {
      if (!entry.isDirectory() || referenced.has(entry.name)) continue;
      await rm(join(packages, entry.name), { recursive: true, force: true });
      removed.push(join("packages", entry.name));
    }
  }
  const temporary = join(root, ".tmp");
  if (existsSync(temporary)) {
    await rm(temporary, { recursive: true, force: true });
    removed.push(".tmp");
  }
  return { removed };
}

export function createLocalRuntimeServicePackageInstaller(
  options: LocalRuntimeServiceOptions = {},
): ZelavisServicePackageInstaller {
  const serviceDirectory = resolve(options.directory ?? ".zelavis/services");
  const acquisitionPolicy = resolveAcquisitionPolicy(options);


  /**
   * Fetches a package under the source policy and writes it down.
   *
   * The policy's refusals and the network's failures are different answers:
   * a refused source is this installation's configuration and will refuse
   * again, while a failed fetch may well work on a retry. They arrived as one
   * thrown Error and became one 400.
   */
  const acquire = Effect.fn("ServicePackageInstaller.acquire")(function* (
    input: ZelavisServicePackageAcquireInput,
  ) {
    const acquired = yield* Effect.tryPromise({
      try: async () => {
        const gate = options.acquisitionGate;
        const ref = gate
          ? parsePackageSourceRef(input.reference, {
              defaultRegistry: options.defaultRegistry ?? ZELAVIS_DEFAULT_NPM_REGISTRY,
            })
          : undefined;
        // Before anything is fetched: the package and the exact version must
        // be on the list. A tag or a range is never a listed version.
        if (gate && ref?.kind === "npm") {
          await gate.authorize({ name: ref.name, version: ref.version });
        } else if (gate && ref && !options.sources?.archives && !options.sources?.git) {
          throw new ZelavisValidationError(
            "Only packages on the marketplace allow-list can be installed from a source reference.",
          );
        }
        const result = await acquirePackage(input.reference, {
          policy: acquisitionPolicy,
          defaultRegistry: options.defaultRegistry,
        });
        // After the bytes arrived: they must be the bytes that were vouched for.
        if (gate && ref?.kind === "npm") {
          const resolved = result.resolved.replace(/^npm:/, "");
          const at = resolved.lastIndexOf("@");
          await gate.verifyAcquired({
            name: resolved.slice(0, at),
            version: resolved.slice(at + 1),
            integrity: result.integrity,
          });
        }
        return result;
      },
      // Validation is the policy talking: an unallowed registry, a range
      // where an exact version is required, a name that is not a name.
      catch: (cause) =>
        cause instanceof ZelavisValidationError ||
        (cause as { name?: string } | undefined)?.name === "AllowlistRefusal"
          ? new SourceRefused({ reference: input.reference, reason: (cause as Error).message })
          : new AcquisitionFailed({ reference: input.reference, cause }),
    });

    const entry = yield* Effect.try({
      try: () => resolveServicePackageEntry(acquired.entries),
      catch: (cause) =>
        new UnusablePackage({
          reference: input.reference,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // A service carries what it needs: the Platform installs nobody's
    // dependencies, so one that lists some would fail to load, and it should
    // say why here, before anything is written down, not at import.
    yield* Effect.try({
      try: () => {
        const manifestEntry = acquired.entries.find((candidate) => candidate.path === "package.json");
        const missing = manifestEntry
          ? unprovidedDependencies(JSON.parse(new TextDecoder().decode(manifestEntry.body)))
          : [];
        if (missing.length > 0) {
          throw new Error(
            `${acquired.resolved} lists runtime dependencies the Platform does not install (${missing.join(", ")}). ` +
              "A service has to carry what it needs, bundled into its own files; only zelavis and effect come from the host.",
          );
        }
      },
      catch: (cause) =>
        new UnusablePackage({
          reference: input.reference,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // Addressed by the verified digest rather than a hash of the bytes we
    // happened to receive: the digest is what the source committed to, and it
    // is what makes two installs of the same reference the same install.
    const packageDirectory = yield* materializePackage(
      serviceDirectory,
      createHash("sha256").update(acquired.integrity).digest("hex"),
      acquired.entries,
      input.reference,
    );

    return {
      specifier: join(packageDirectory, entry),
      resolved: acquired.resolved,
      integrity: acquired.integrity,
      message: `Installed ${acquired.resolved}.`,
    };
  });

  /**
   * Scaffolds a frontend package by running a create package's bin.
   *
   * The create package is acquired through the same verified path as any other
   * install, so the source policy governs what can be run here. What the run
   * produces is then treated exactly like an uploaded package: validated as a
   * Zelavis frontend, materialized content-addressed, and returned as a
   * specifier the registry installs. A scaffold that did not produce a
   * frontend is refused rather than registered as something else.
   */
  /**
   * Scaffolds a frontend by running a create package's bin.
   *
   * The create package is acquired through the same verified path as any
   * other install, so the source policy governs what can be run here. What
   * the run produces is then treated exactly like an uploaded package:
   * validated as a Zelavis frontend, materialized content-addressed, and
   * returned as a specifier the registry installs. A scaffold that did not
   * produce a frontend is refused rather than registered as something else.
   */
  const scaffold = Effect.fn("ServicePackageInstaller.scaffold")(function* (
    input: ZelavisServicePackageScaffoldInput,
  ) {
    const acquired = yield* Effect.tryPromise({
      try: () =>
        acquirePackage(input.reference, {
          policy: acquisitionPolicy,
          defaultRegistry: options.defaultRegistry,
        }),
      catch: (cause) =>
        cause instanceof ZelavisValidationError
          ? new SourceRefused({ reference: input.reference, reason: (cause as Error).message })
          : new AcquisitionFailed({ reference: input.reference, cause }),
    });

    const unusable = (reason: string) =>
      new UnusablePackage({ reference: input.reference, reason });

    const manifestEntry = acquired.entries.find((entry) => entry.path === "package.json");
    if (!manifestEntry) {
      return yield* unusable("A create package must include package.json.");
    }

    const binPath = yield* Effect.try({
      try: () => {
        const createManifest = JSON.parse(
          new TextDecoder().decode(manifestEntry.body),
        ) as ZelavisPackageManifest & { bin?: unknown };
        return resolveCreatePackageBin(createManifest, input.command);
      },
      catch: (cause) =>
        unusable(cause instanceof Error ? cause.message : String(cause)),
    });

    const createDirectory = yield* materializePackage(
      serviceDirectory,
      createHash("sha256").update(acquired.integrity).digest("hex"),
      acquired.entries,
      input.reference,
    );

    // Run-local, and removed whatever happens -- including an interruption,
    // which the previous `finally` did not cover. A half-finished scaffold is
    // not something a later run should find and reuse.
    const runDirectory = yield* Effect.acquireRelease(
      Effect.sync(() => join(serviceDirectory, ".scaffold", randomUUID())),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const outputDirectory = join(runDirectory, "out");

    const entries = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(outputDirectory, { recursive: true });
        await runCreatePackage({
          packageDirectory: createDirectory,
          binPath,
          outputDirectory,
          runDirectory,
          args: input.args,
          ...(options.scaffoldTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.scaffoldTimeoutMs }),
        });
        return readScaffoldOutput(outputDirectory);
      },
      catch: (cause) =>
        unusable(cause instanceof Error ? cause.message : String(cause)),
    });

    const entry = yield* Effect.try({
      try: () => resolveScaffoldedFrontendEntry(entries),
      catch: (cause) =>
        unusable(cause instanceof Error ? cause.message : String(cause)),
    });

    const packageDirectory = yield* materializePackage(
      serviceDirectory,
      createHash("sha256")
        .update(
          entries
            .map(
              (item) =>
                `${item.path}:${createHash("sha256").update(item.body).digest("hex")}`,
            )
            .join("\n"),
        )
        .digest("hex"),
      entries,
      input.reference,
    );

    return {
      specifier: join(packageDirectory, entry),
      resolved: acquired.resolved,
      integrity: acquired.integrity,
      message: `Scaffolded a frontend with ${acquired.resolved}.`,
    };
  });

  return {
    install: Effect.fn("ServicePackageInstaller.install")(function* (input) {
      if (!input.fileName.toLowerCase().endsWith(".zip")) {
        return yield* new UnusablePackage({
          reference: input.fileName,
          reason: "Service package uploads must be ZIP archives.",
        });
      }

      // Reading the archive and finding its entry point are the caller's
      // problem with the file they sent, not ours with the disk.
      const { entries, entry } = yield* Effect.try({
        try: () => {
          const read = readZipEntries(input.body);
          return { entries: read, entry: resolveServicePackageEntry(read) };
        },
        catch: (cause) =>
          new UnusablePackage({
            reference: input.fileName,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });

      const packageDirectory = yield* materializePackage(
        serviceDirectory,
        createHash("sha256").update(input.body).digest("hex"),
        entries,
        input.fileName,
      );

      return {
        specifier: join(packageDirectory, entry),
        message: `Installed service package ${input.fileName}.`,
      };
    }),

    // Present only when sources are actually configured.
    //
    // Callers decide whether to offer installing from a source by whether this
    // exists, so it has to mean "this will work" rather than "this host has the
    // code for it". An installer that always exposed it would advertise a
    // capability that refuses every call.
    //
    // Scaffolding is gated on the same policy for the same reason: it begins
    // with the same verified acquisition, and a host that acquires nothing has
    // no create package to run.
    ...(acquisitionPolicy ? { acquire, scaffold } : {}),
  };
}

/**
 * Validates that a scaffold produced a Zelavis frontend and resolves its entry.
 *
 * The generic service check answers "is this a Zelavis package"; a scaffold
 * registered as a frontend has to also be one, or the Project it becomes runs
 * under a driver that does not match what was written.
 */
function resolveScaffoldedFrontendEntry(
  entries: readonly PackageEntry[],
): string {
  const manifestEntry = entries.find((entry) => entry.path === "package.json");
  if (!manifestEntry) {
    throw new Error(
      "The scaffold produced no package.json, so it is not an installable frontend.",
    );
  }

  let manifest: ZelavisPackageManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(manifestEntry.body),
    ) as ZelavisPackageManifest;
  } catch {
    throw new Error("The scaffold's package.json is not valid JSON.");
  }

  if (!readFrontendManifest(manifest)) {
    throw new Error(
      `The scaffold produced "${manifest.name ?? "an unnamed package"}", which does not declare "zelavis": { "kind": "frontend" }.`,
    );
  }

  return resolveServicePackageEntry(entries);
}

/**
 * Resolves the package directory for a frontend Project's locked recipe.
 *
 * A recipe lock names the entry module of an installed package, so the package
 * root is the nearest ancestor holding a `package.json`. Walking up rather than
 * assuming a fixed depth keeps this working for a package whose entry is
 * `dist/index.js`, `src/index.js`, or the root itself.
 *
 * A specifier that is not a path — a bare package name, or a `data:` module —
 * is refused rather than guessed at. A frontend runs files from a directory,
 * and there is no directory to run.
 */
export function createLocalFrontendDirectoryResolver(
  options: LocalRuntimeServiceOptions = {},
): (
  project: unknown,
  recipe: { readonly name: string; readonly specifier: string },
) => Promise<string> {
  const serviceDirectory = resolve(options.directory ?? ".zelavis/services");

  return async (_project, recipe) => {
    const specifier = recipe.specifier;
    if (!specifier || !specifier.startsWith("/")) {
      throw new Error(
        `Frontend "${recipe.name}" is not installed as a package directory. Install it from a source before running it.`,
      );
    }

    // Bounded by the service directory: a lock pointing outside the place
    // packages are installed is not something to walk the filesystem for.
    const root = serviceDirectory;
    if (!isManagedServicePath(specifier, root)) {
      throw new Error(
        `Frontend "${recipe.name}" recipe lock does not point at an installed package.`,
      );
    }
    const physicalRoot = realpathSync(root);
    let current = dirname(realpathSync(specifier));
    while (isPathWithin(current, physicalRoot) && current !== physicalRoot) {
      const manifestPath = join(current, "package.json");
      if (existsSync(manifestPath)) {
        if (!isManagedServicePath(manifestPath, current)) {
          throw new Error(`Frontend "${recipe.name}" manifest does not point at an installed package.`);
        }
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    throw new Error(
      `Frontend "${recipe.name}" has no package.json under ${root}; its recipe lock does not point at an installed package.`,
    );
  };
}

// ---------------------------------------------------------------------------
// Service importer (specifier → ESM module)
// ---------------------------------------------------------------------------

export function createLocalRuntimeServiceImporter(
  options: LocalRuntimeServiceOptions = {},
): NonNullable<ZelavisServiceLoadOptions["importer"]> {
  const serviceDirectory = resolve(options.directory ?? ".zelavis/services");
  const managedDirectories = [
    serviceDirectory,
    ...(options.managedDirectories ?? []).map((directory) => resolve(directory)),
  ];
  // A service finds `zelavis` and `effect` in the host, wherever its folder lies.
  for (const directory of managedDirectories) provideHostPackagesTo(directory);
  // Packages shipped in this distribution's `services/` folder are the host's
  // own code: the same trust as a bare dependency, and immutable to operators.
  const isManaged = (path: string) =>
    managedDirectories.some((directory) => isManagedServicePath(path, directory)) ||
    isBundledServicePath(path);
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
      if (!sources.filesystem && !isManaged(fileURLToPath(specifier))) {
        refuse("file:", "filesystem");
      }
      const originalUrl = new URL(specifier);
      const physicalUrl = pathToFileURL(realpathSync(fileURLToPath(originalUrl)));
      physicalUrl.search = originalUrl.search;
      physicalUrl.hash = originalUrl.hash;
      return import(physicalUrl.href);
    }

    if (looksLikePathSpecifier(specifier)) {
      if (!sources.filesystem && !isManaged(specifier)) {
        refuse("Filesystem path", "filesystem");
      }
      return importFilePath(realpathSync(specifier));
    }

    // A bare package specifier resolves through the host's own installed
    // dependencies, which is the same trust as the host's own code. When
    // nothing is installed under that name, a core service bundled in this
    // distribution answers instead — the same trust again, since it shipped
    // as part of the host.
    try {
      return await import(specifier);
    } catch (error) {
      // Only a resolution failure falls through. A package that is installed
      // but throws while loading must surface its own error, not be quietly
      // replaced by the bundled copy of the same name.
      const code = (error as { code?: string } | undefined)?.code;

      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
        throw error;
      }

      const bundled = resolveBundledServiceDirectory(specifier);
      const entry = bundled ? bundledServiceEntry(bundled) : undefined;

      if (!entry) {
        throw error;
      }

      return import(pathToFileURL(entry).href);
    }
  };
}

// ---------------------------------------------------------------------------
// Core services bundled in the distribution
// ---------------------------------------------------------------------------

/**
 * The distribution carries its core services — `@zelavis/app`, `@zelavis/auth`,
 * `@zelavis/marketplace`, `@zelavis/ui` — inside its own `services/` folder.
 *
 * Resolving them by bare name through `import.meta.resolve` looks in
 * `node_modules` and finds nothing there, so they had to be declared as
 * registry dependencies and published as separate packages purely to satisfy
 * resolution. Reading the folder that already ships beside the code removes
 * that requirement: the package installs and runs standalone.
 *
 * An installed copy of the same name still wins, because the lookup runs only
 * after the ordinary resolution fails.
 */
let bundledServiceIndex: Map<string, string> | undefined;

/** Locates the `services/` folder of the `zelavis` package this module is part of. */
function distributionServicesDirectory(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));

  while (current && current !== dirname(current)) {
    const manifestPath = join(current, "package.json");

    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          name?: string;
        };

        if (raw?.name === "zelavis") {
          return join(current, SERVICES_DIRECTORY);
        }
      } catch {
        // A package.json that will not parse tells us nothing about where we
        // are; keep walking up rather than giving up on the distribution.
      }
    }

    current = dirname(current);
  }

  return undefined;
}

function indexBundledServices(): Map<string, string> {
  if (bundledServiceIndex) {
    return bundledServiceIndex;
  }

  const index = new Map<string, string>();
  const directory = distributionServicesDirectory();

  if (directory && existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const packageDir = join(directory, entry.name);
      const manifestPath = join(packageDir, "package.json");

      if (!existsSync(manifestPath)) {
        continue;
      }

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          name?: string;
        };

        if (typeof raw?.name === "string" && raw.name.length > 0) {
          index.set(raw.name, packageDir);
        }
      } catch {
        // One unreadable folder must not hide the rest of the distribution.
      }
    }
  }

  bundledServiceIndex = index;
  return index;
}

/** Whether a path lies inside a package shipped in this distribution. */
export function isBundledServicePath(path: string): boolean {
  let physical: string;
  try {
    physical = realpathSync(path);
  } catch {
    return false;
  }
  return [...indexBundledServices().values()].some((directory) => {
    try {
      return isManagedServicePath(physical, realpathSync(directory));
    } catch {
      return false;
    }
  });
}

/** Absolute directory of a core service shipped inside this distribution. */
export function resolveBundledServiceDirectory(
  packageName: string,
): string | undefined {
  return indexBundledServices().get(packageName);
}

/**
 * The directory of a package the marketplace installed, from the registry's own
 * record of it (the registry stores the path of its entry file).
 */
async function installedPackageDirectory(
  store: ZelavisSystemStore,
  name: string,
): Promise<string | undefined> {
  const entries = await createSystemStoreServiceRegistryStore(store).read();
  const specifier = entries.find((entry) => entry.name === name)?.specifier;
  if (!specifier || !isAbsolute(specifier)) return undefined;
  // Walk up from the entry file to the package.json that names this package.
  for (let current = dirname(specifier); current !== dirname(current); current = dirname(current)) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === name) return current;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Loads a package the host itself selected (bundled, or a recipe artifact it
 * materialized and verified) through the ordinary package loader. Trust comes
 * from that host-side selection, never from anything the package exports.
 */
export async function loadSystemPackage(
  manifest: ZelavisPackageManifest & { packageDir: string },
) {
  return loadPluginPackage({
    manifest,
    packageDir: manifest.packageDir,
    scope: "system",
    importer: (entry) => import(pathToFileURL(entry).href),
  });
}

export interface BundledServiceCatalogSelection {
  readonly name: string;
  readonly status: "installed" | "available";
  readonly order?: number;
}

/**
 * Loads official distribution packages through the ordinary package loader.
 * Their trust comes from this host-selected immutable source, never an export.
 */
export async function loadBundledServiceCatalog(
  selections: readonly BundledServiceCatalogSelection[],
): Promise<readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[]> {
  return Promise.all(
    selections.map(async (selection) => {
      const manifest = resolveLocalPackageManifest(selection.name);
      if (!manifest) {
        throw new Error(
          `Unable to resolve bundled service manifest for ${selection.name}.`,
        );
      }

      const service = await loadSystemPackage(manifest);

      return Object.freeze({
        service,
        specifier: selection.name,
        status: selection.status,
        source: "official" as const,
        ...(selection.order === undefined ? {} : { order: selection.order }),
        manifest,
      });
    }),
  );
}

/**
 * The official service catalog every host adapter starts from: the packages the
 * distribution bundles. Everything else officially maintained (WordPress, and
 * the rest of `zelavis-services`) comes through the marketplace.
 */
export async function loadOfficialServiceCatalog(): Promise<
  readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[]
> {
  return loadBundledServiceCatalog([
    { name: "@zelavis/app", status: "available", order: 0 },
    { name: "@zelavis/marketplace", status: "installed", order: 10 },
    { name: "@zelavis/auth", status: "installed", order: 20 },
  ]);
}

const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
});

/**
 * Serves the static bundle of packages that live in a services folder.
 *
 * A frontend dropped into a runtime's services folder is already on disk, so
 * its bundle is read from the package directory instead of being uploaded into
 * shared file storage. Only the packages this host discovered are served, each
 * confined to its declared bundle directory; anything else falls through to
 * `fallback`.
 */
export function createPackageDirectoryBundleStore(
  packageDirectories: ReadonlyMap<string, string>,
  fallback?: BundleStore,
): BundleStore {
  const read = async (scope: BundleScope, path: string): Promise<BundleAsset | undefined> => {
    const packageDirectory = packageDirectories.get(scope.serviceName);
    if (!packageDirectory) return fallback?.read(scope, path);

    const bundleRoot = resolve(packageDirectory, scope.bundle);
    const target = resolve(bundleRoot, path.replace(/^\/+/, ""));
    if (!isPathWithin(target, bundleRoot)) return undefined;

    try {
      const physical = realpathSync(target);
      // A symlink inside the bundle must not lead out of the package.
      if (!isPathWithin(physical, realpathSync(bundleRoot))) return undefined;
      if (!(await stat(physical)).isFile()) return undefined;
      const body = new Uint8Array(await readFile(physical));
      const extension = physical.slice(physical.lastIndexOf(".")).toLowerCase();
      return {
        path,
        body,
        size: body.byteLength,
        contentType: BUNDLE_CONTENT_TYPES[extension] ?? "application/octet-stream",
      };
    } catch {
      return undefined;
    }
  };

  return {
    read,
    ...(fallback?.deleteProject
      ? { deleteProject: (projectId: string) => fallback.deleteProject!(projectId) }
      : {}),
  };
}

/** Entry module of a bundled service, from its own `exports` or `main`. */
function bundledServiceEntry(packageDir: string): string | undefined {
  let raw: {
    exports?: unknown;
    module?: string;
    main?: string;
  };

  try {
    raw = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf-8"),
    ) as typeof raw;
  } catch {
    return undefined;
  }

  const root = (raw.exports as Record<string, unknown> | undefined)?.["."];
  const candidate =
    typeof root === "string"
      ? root
      : typeof root === "object" && root !== null
        ? ((root as Record<string, unknown>).import ??
            (root as Record<string, unknown>).default)
        : undefined;

  const entry =
    (typeof candidate === "string" ? candidate : undefined) ??
    raw.module ??
    raw.main;

  if (!entry) {
    return undefined;
  }

  const resolved = join(packageDir, entry);
  return existsSync(resolved) ? resolved : undefined;
}

// ---------------------------------------------------------------------------
// Service manifest resolver (specifier → package.json)
// ---------------------------------------------------------------------------

/**
 * Automatically discovers and resolves the `package.json` manifest for a given
 * package specifier, filesystem path, or file URL.
 *
 * For bare package names (e.g. `@zelavis/auth`), uses Node's standard `import.meta.resolve`
 * and walks up to the owning directory to read `package.json`.
 * For filesystem paths and file URLs, walks up from the entry module or directory to find `package.json`.
 *
 * Injects `packageDir` directly as the absolute path of the directory containing `package.json`.
 */
export function resolveLocalPackageManifest(
  specifierOrPath: string,
): (ZelavisPackageManifest & { packageDir: string }) | undefined {
  if (!specifierOrPath || typeof specifierOrPath !== "string") {
    return undefined;
  }

  if (
    isRemoteSpecifier(specifierOrPath) ||
    isDataSpecifier(specifierOrPath)
  ) {
    return undefined;
  }

  const isBareSpecifier =
    !specifierOrPath.startsWith("file://") &&
    !specifierOrPath.startsWith("/") &&
    !specifierOrPath.startsWith("./") &&
    !specifierOrPath.startsWith("../");

  let startPath: string;
  if (specifierOrPath.startsWith("file://")) {
    startPath = fileURLToPath(specifierOrPath);
  } else if (!isBareSpecifier) {
    startPath = resolve(specifierOrPath);
  } else {
    const bundled = resolveBundledServiceDirectory(specifierOrPath);

    try {
      const resolvedUrl = import.meta.resolve(specifierOrPath);
      startPath = fileURLToPath(resolvedUrl);
    } catch {
      // Nothing is installed under that name. A core service bundled in this
      // distribution lives in its own folder rather than in node_modules, so
      // it never resolves this way and has to be looked up directly.
      startPath = bundled ?? resolve(specifierOrPath);
    }
  }

  const parseAndValidate = (manifestPath: string, packageDir: string) => {
    if (!existsSync(manifestPath)) return undefined;
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as ZelavisPackageManifest;
    if (!raw || typeof raw !== "object" || !raw.zelavis || typeof raw.zelavis !== "object" || !raw.zelavis.kind) {
      return undefined;
    }
    if (isBareSpecifier && raw.name !== specifierOrPath) {
      return undefined;
    }
    return {
      ...raw,
      packageDir,
    };
  };

  try {
    let current = startPath;
    if (existsSync(current) && statSync(current).isDirectory()) {
      const result = parseAndValidate(join(current, "package.json"), current);
      if (result) return result;
    }

    current = dirname(startPath);
    while (current && current !== dirname(current)) {
      const result = parseAndValidate(join(current, "package.json"), current);
      if (result) return result;
      current = dirname(current);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Resolves the `package.json` manifest that sits beside a local service
 * specifier. This lives in the local-runtime adapter, not the runtime core,
 * because filesystem plugin scanning is an explicit core non-goal.
 */
export function createLocalRuntimeServiceManifestResolver(): ZelavisServiceManifestResolver {
  return async (specifier) => {
    return resolveLocalPackageManifest(specifier);
  };
}

// ---------------------------------------------------------------------------
// services discovery
// ---------------------------------------------------------------------------

/** Folder name operators drop service packages into, under the data directory. */
export const SERVICES_DIRECTORY = "services";

export interface ServiceDiscoveryOptions {
  /** Absolute path of the folder to scan. */
  directory: string;
  /**
   * Called once per package that cannot be used, with the reason. Discovery
   * never throws for a bad package: one malformed folder must not stop a
   * Platform from booting, or an operator could brick their installation by
   * dropping in a broken download.
   */
  onSkipped?: (name: string, reason: string) => void;
}

async function readDirectoryEntries(directory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules");
  } catch {
    // A missing folder is the normal case for an installation nobody has added
    // anything to, not an error.
    return [];
  }
}

/**
 * Lists the package directories in a services folder.
 *
 * Scoped packages live one level deeper, exactly as they do in node_modules,
 * so `@acme/theme` is the directory `@acme/theme` rather than a flattened name.
 */
async function listProductServicePackages(directory: string): Promise<string[]> {
  const packages: string[] = [];
  for (const name of await readDirectoryEntries(directory)) {
    // Managed install/upload artifacts are addressed by registry state below
    // this directory; the directory itself is not a manually dropped package.
    if (name === "packages") {
      continue;
    }
    if (name.startsWith("@")) {
      for (const scoped of await readDirectoryEntries(join(directory, name))) {
        packages.push(join(name, scoped));
      }
      continue;
    }
    packages.push(name);
  }
  return packages.sort();
}

/**
 * Discovers installable services from a folder on this server.
 *
 * This is the WordPress `wp-content/plugins` shape: an operator drops a package
 * in, restarts, and the Platform picks it up. Code found here runs with
 * Platform authority — which is inherent to a folder on the operator's own
 * server, and the reason discovery refuses anything that resolves outside its
 * own package directory rather than trusting the manifest's own paths.
 */
/**
 * Makes `zelavis` resolvable from packages in the services folder.
 *
 * A package dropped into a folder outside `node_modules` cannot resolve its
 * own peer dependency: Node walks parent directories looking for
 * `node_modules/zelavis` and finds none, so any service importing
 * `zelavis/app/identity` fails to load. Nearly every real plugin does.
 *
 * Linking the running Platform package into `<folder>/node_modules` puts it
 * exactly where that walk looks. The link points at whichever `zelavis` is
 * actually executing, so a folder package always compiles against the same
 * Platform that loaded it rather than some other copy on the machine.
 */
export async function linkPlatformPackage(folder: string): Promise<void> {
  const { mkdir: makeDirectory, symlink, readlink } = await import("node:fs/promises");
  // Four levels up from `dist/adapters/_local-runtime.js` is the package root.
  const platformRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const modules = join(folder, "node_modules");
  const link = join(modules, "zelavis");

  try {
    if (existsSync(link)) {
      // Repointed when it is stale, so upgrading or moving the Platform does
      // not leave every folder package importing a version that is gone.
      const current = await readlink(link).catch(() => undefined);
      if (current && resolve(dirname(link), current) === platformRoot) return;
      await rm(link, { recursive: true, force: true });
    }
    await makeDirectory(modules, { recursive: true });
    await symlink(platformRoot, link, "junction");
  } catch {
    // Symlinks can be unavailable (restricted Windows accounts, some
    // containers). Discovery continues: self-contained packages still load,
    // and the ones that need the Platform report their own import failure.
  }
}

export async function discoverProductServices(
  options: ServiceDiscoveryOptions,
): Promise<ZelavisServiceRegistryModuleEntry[]> {
  const root = resolve(options.directory);
  const skip = (name: string, reason: string) => options.onSkipped?.(name, reason);
  const discovered: ZelavisServiceRegistryModuleEntry[] = [];
  const packageNames = await listProductServicePackages(root);
  if (packageNames.length > 0) {
    await linkPlatformPackage(root);
  }

  for (const packageName of packageNames) {
    const packageDirectory = join(root, packageName);
    let manifest;
    try {
      manifest = validatePluginPackageManifest(
        JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")),
      );
    } catch (error) {
      skip(packageName, error instanceof Error ? error.message : String(error));
      continue;
    }

    // A frontend may be files with no JavaScript entry. It is discovered by its
    // directory: there is nothing to import, and the package loader serves it
    // from the manifest alone.
    if (manifest.zelavis?.kind === "frontend" && manifest.exports === undefined) {
      if (!isManagedServicePath(packageDirectory, root) ||
          !isManagedServicePath(join(packageDirectory, "package.json"), packageDirectory)) {
        skip(packageName, 'its physical source resolves outside the package directory or discovery root.');
        continue;
      }
      discovered.push({
        specifier: pathToFileURL(realpathSync(packageDirectory)).href,
        status: "installed",
        source: "community",
        packageDir: packageDirectory,
        manifest: { ...manifest, packageDir: packageDirectory },
      });
      continue;
    }

    let entryPath: string;
    try {
      entryPath = resolve(packageDirectory, resolvePackageExportsEntry(manifest.exports));
    } catch (error) {
      skip(packageName, error instanceof Error ? error.message : String(error));
      continue;
    }

    // The manifest is data supplied by whoever wrote the package, so its
    // exports path is not allowed to reach out of the package it belongs to.
    // Without this an `exports` of "../../../etc/something" would make the
    // Platform import a file the operator never put in this folder.
    if (!isPathWithin(entryPath, packageDirectory)) {
      skip(packageName, 'its "exports" entry resolves outside the package directory.');
      continue;
    }
    if (!existsSync(entryPath)) {
      skip(packageName, `its entry file ${relative(root, entryPath)} does not exist.`);
      continue;
    }

    if (!isManagedServicePath(packageDirectory, root) ||
        !isManagedServicePath(join(packageDirectory, "package.json"), packageDirectory) ||
        !isManagedServicePath(entryPath, packageDirectory)) {
      skip(packageName, 'its physical source resolves outside the package directory or discovery root.');
      continue;
    }

    const entryUrl = pathToFileURL(realpathSync(entryPath)).href;
    discovered.push({
      specifier: entryUrl,
      status: "installed",
      source: "community",
      packageDir: packageDirectory,
      // `exports` is rewritten to the entry this scan actually resolved and
      // containment-checked. Plugin loading imports the manifest's `exports`
      // string verbatim, so leaving it relative would import "./index.js"
      // against the Platform's working directory rather than against the
      // package the file came from.
      manifest: { ...manifest, exports: entryUrl, packageDir: packageDirectory },
    });
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Everything a local host needs to serve services, in one place
// ---------------------------------------------------------------------------

export type LocalServiceSourceOptions = LocalRuntimeServiceOptions & {
  /** The marketplace allow-list and, for development, a checkout of the official services. */
  marketplace?: MarketplaceOptions;
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
  /**
   * Folder on this server that services are dropped into.
   *
   * Defaults to `<dataDirectory>/services`. It lives here rather than in an
   * option of its own because two options both named for services is how the
   * folder and the registry drifted apart in the first place.
   */
  directory?: string;
};

export interface LocalServiceSourcesInput {
  dataDirectory: string;
  /** The adapter's `services` option; `false` turns every service source off. */
  services: false | LocalServiceSourceOptions | undefined;
  isProjectRuntime: boolean;
  fileStorage?: ZelavisFileStorage;
  /** Where the allow-list is cached. */
  systemStore?: ZelavisSystemStore;
  /** Where the Platform's Projects live, so a refreshed allow-list can be handed to each. */
  projectsDirectory?: string;
}

export interface LocalServiceSources {
  /** The marketplace this host built, for its status and refresh operations. */
  marketplace?: LocalMarketplace;
  /**
   * Where a recipe package lies: the checkout copy in development, or the copy
   * the marketplace installed. What Projects are frozen from when it is not bundled.
   */
  recipePackageDirectory?: (name: string) => Promise<string | undefined>;
  /** Whether the marketplace lets a recipe provide the runtime its Projects run under. */
  recipeRuntimeTrusted?: (name: string) => Promise<boolean>;
  serviceRegistry?: ZelavisServiceRegistryOptions;
  servicePackages?: LocalServicePackageInstaller;
  bundleStore?: BundleStore;
}

/**
 * The service sources of one local runtime: the official catalog, packages
 * dropped into its services folder, installed and uploaded packages, and the
 * bundle store that serves folder frontends from where they lie.
 *
 * Node and Bun both call this, so the two hosts cannot drift apart: what a
 * Project or the Platform loads from its own `services` folder is the same on
 * either. Only filesystem and module-loading APIs both hosts provide are used.
 */
export async function createLocalServiceSources(
  input: LocalServiceSourcesInput,
): Promise<LocalServiceSources> {
  if (input.services === false) return {};

  const serviceOptions = input.services;
  const serviceDirectory = join(input.dataDirectory, SERVICES_DIRECTORY);
  const productServiceDirectory = serviceOptions?.directory
    ? resolve(serviceOptions.directory)
    : serviceDirectory;

  // Scanned before composition so the runtime sees dropped-in services the same
  // way it sees installed ones. Every runtime has its own folder: the
  // Platform's is `<data>/services`, and a Project's is the `services` folder
  // of its own `.zelavis` data root, so what a Project installs belongs to that
  // Project and to no other.
  const discovered = await discoverProductServices({
    directory: productServiceDirectory,
    onSkipped: (name, reason) => {
      // Reported rather than swallowed: a package that silently fails to load
      // looks identical to one nobody installed.
      console.warn(`Zelavis skipped product service "${name}": ${reason}`);
    },
  });

  // What the registry no longer points at is removed, once, before anything is
  // loaded. Best effort: a registry that cannot be read leaves everything in place.
  if (input.systemStore) {
    const store = input.systemStore;
    void (async () => {
      const entries = await createSystemStoreServiceRegistryStore(store).read();
      await pruneServicePackages({
        directory: productServiceDirectory,
        referencedSpecifiers: entries.flatMap((entry) => (entry.specifier ? [entry.specifier] : [])),
      });
    })().catch(() => undefined);
  }

  // Static frontends dropped into this runtime's services folder are served
  // from where they lie. Other bundles keep using the shared store.
  const folderFrontends = new Map(
    discovered.flatMap((entry) =>
      entry.manifest?.zelavis?.kind === "frontend" &&
      entry.manifest.exports === undefined &&
      entry.packageDir
        ? [[entry.manifest.name, entry.packageDir] as const]
        : [],
    ),
  );

  const official = input.isProjectRuntime ? [] : await loadOfficialServiceCatalog();
  // The marketplace: what its allow-list offers, the gate that decides what may
  // be installed, and (in a development checkout) the official services on disk.
  // A Project has one too, for what may be installed into it: the same list and
  // the same gate, offering plugins and frontends (an app is a Project, not
  // something installed into one).
  const marketplace = await createLocalMarketplace({
    options: serviceOptions?.marketplace,
    systemStore: input.systemStore,
    bundledNames: new Set(official.map((entry) => entry.service.name)),
    role: input.isProjectRuntime ? "project" : "platform",
    dataDirectory: input.dataDirectory,
    ...(input.projectsDirectory ? { projectsDirectory: input.projectsDirectory } : {}),
  });
  const installerOptions = {
    directory: serviceDirectory,
    ...(serviceOptions ?? {}),
    ...(marketplace?.gate ? { acquisitionGate: marketplace.gate } : {}),
  };

  return {
    ...(folderFrontends.size > 0
      ? {
          bundleStore: createPackageDirectoryBundleStore(
            folderFrontends,
            input.fileStorage
              ? createSharedBundleStore({ storage: input.fileStorage })
              : undefined,
          ),
        }
      : {}),
    serviceRegistry: {
      catalog: input.isProjectRuntime
        ? (marketplace?.catalog ?? []).filter((entry) => entry.service.kind !== "app")
        : [...official, ...(marketplace?.catalog ?? []), ...(serviceOptions?.catalog ?? [])],
      discovered,
      importer: createLocalRuntimeServiceImporter({
        directory: serviceDirectory,
        ...(serviceOptions ?? {}),
        managedDirectories: [
          productServiceDirectory,
          ...(marketplace?.managedDirectories ?? []),
          ...(serviceOptions?.managedDirectories ?? []),
        ],
      }),
      // Supplied per runtime rather than installed process-globally, so two
      // embedded runtimes cannot affect each other.
      manifestResolver: createLocalRuntimeServiceManifestResolver(),
    },
    servicePackages: createLocalRuntimeServicePackageInstaller(installerOptions),
    ...(marketplace ? { marketplace } : {}),
    ...(input.isProjectRuntime
      ? {}
      : {
          recipePackageDirectory: async (name: string) =>
            marketplace?.localPackages.get(name) ??
            (input.systemStore
              ? await installedPackageDirectory(input.systemStore, name)
              : undefined),
          ...(marketplace ? { recipeRuntimeTrusted: (name: string) => marketplace.runtimeTrusted(name) } : {}),
        }),
  };
}
