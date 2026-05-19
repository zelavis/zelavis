import {
  mkdirSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/db-node-sqlite";
import {
  createFileStoragePluginRegistryStore,
  defineAdapter,
  type ZelavisDashboardSettingsStore,
  type ZelavisDashboardSettingsUpdate,
  type ZelavisDashboardThemeMode,
  type ZelavisOptions,
  type ZelavisPluginLoadOptions,
  type ZelavisPluginPackageInstaller,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import {
  createLocalFileStorage,
  createMemoryKeyValueStore,
} from "./_shared.js";

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (path === undefined) {
    return fallback;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "/") {
    return "/";
  }

  const normalized = normalizePathPart(trimmed);
  return normalized ? `/${normalized}` : fallback;
}

function normalizeEditableRootPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path, "/");
}

function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

export function createFileDashboardSettingsStore(
  filePath = ".zelavis/dashboard-settings.json",
): ZelavisDashboardSettingsStore {
  const resolvedPath = resolve(filePath);

  function read(): ZelavisDashboardSettingsUpdate {
    if (!existsSync(resolvedPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Record<
      string,
      unknown
    >;
    const settings: ZelavisDashboardSettingsUpdate = {};

    if (typeof parsed.rootPath === "string") {
      settings.rootPath = normalizeEditableRootPath(parsed.rootPath);
    }

    if (isDashboardThemeMode(parsed.theme)) {
      settings.theme = parsed.theme;
    }

    if (typeof parsed.pageBuilderEnabled === "boolean") {
      settings.pageBuilderEnabled = parsed.pageBuilderEnabled;
    }

    return settings;
  }

  function write(update: ZelavisDashboardSettingsUpdate) {
    const next = {
      ...read(),
      ...update,
    };
    const temporaryPath = `${resolvedPath}.tmp`;

    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporaryPath, resolvedPath);

    return next;
  }

  return {
    read,
    write,
  };
}

export interface NodeAdapterDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export interface NodeAdapterDashboardOptions {
  settingsFile?: string;
}

export interface NodeAdapterPluginOptions {
  directory?: string;
  allowRemote?: boolean;
}

export interface NodeAdapterOptions {
  dataDirectory?: string;
  database?: false | NodeAdapterDatabaseOptions;
  dashboard?: false | NodeAdapterDashboardOptions;
  plugins?: false | NodeAdapterPluginOptions;
  files?: false | {
    rootDirectory?: string;
  };
  kv?: false | {
    kind?: "memory";
  };
}

function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

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

interface NodeZipEntry {
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

  throw new Error("Plugin package is not a valid ZIP archive.");
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
    throw new Error("Plugin package contains an invalid ZIP local header.");
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

function readZipEntries(bytes: Uint8Array): NodeZipEntry[] {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUInt16(bytes, endOffset + 10);
  const centralDirectoryOffset = readUInt32(bytes, endOffset + 16);
  const decoder = new TextDecoder();
  const entries: NodeZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50) {
      throw new Error("Plugin package contains an invalid ZIP central directory.");
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
        body: inflateZipEntry(
          bytes,
          method,
          compressedSize,
          localHeaderOffset,
        ),
      });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function resolvePluginPackageEntry(entries: readonly NodeZipEntry[]): string {
  const manifest = entries.find((entry) => entry.path === "zelavis.plugin.json");

  if (!manifest) {
    throw new Error("Plugin package must include zelavis.plugin.json.");
  }

  const parsed = JSON.parse(new TextDecoder().decode(manifest.body)) as {
    entry?: unknown;
  };
  const entry = typeof parsed.entry === "string" ? parsed.entry.trim() : "";
  const normalized = normalizeZipEntryPath(entry.replace(/^\.\//, ""));

  if (!normalized) {
    throw new Error("Plugin package manifest must include a valid entry path.");
  }

  if (!entries.some((candidate) => candidate.path === normalized)) {
    throw new Error(`Plugin package entry "${normalized}" does not exist.`);
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
    throw new Error(`Plugin package path "${path}" escapes the package root.`);
  }

  return resolved;
}

async function importFilePath(filePath: string) {
  const resolvedPath = resolve(filePath);
  const fileStat = await stat(resolvedPath);
  return import(`${pathToFileURL(resolvedPath).href}?mtime=${fileStat.mtimeMs}`);
}

async function downloadRemotePlugin(
  specifier: string,
  pluginDirectory: string,
): Promise<string> {
  const response = await fetch(specifier);

  if (!response.ok) {
    throw new Error(
      `Failed to download plugin module from ${specifier}: ${response.status}`,
    );
  }

  const source = await response.text();
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const specifierHash = createHash("sha256").update(specifier).digest("hex");
  const pluginPath = join(pluginDirectory, specifierHash, `${sourceHash}.mjs`);

  await writeFile(pluginPath, source, { flag: "wx" }).catch(async (error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      mkdirSync(dirname(pluginPath), { recursive: true });
      await writeFile(pluginPath, source, { flag: "wx" }).catch((nextError) => {
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

  return pluginPath;
}

export function createNodePluginPackageInstaller(
  options: NodeAdapterPluginOptions = {},
): ZelavisPluginPackageInstaller {
  const pluginDirectory = resolve(options.directory ?? ".zelavis/plugins");

  return {
    async install(input) {
      const fileName = input.fileName.toLowerCase();

      if (!fileName.endsWith(".zip")) {
        throw new Error("Node plugin package uploads must be ZIP archives.");
      }

      const packageHash = createHash("sha256").update(input.body).digest("hex");
      const entries = readZipEntries(input.body);
      const entry = resolvePluginPackageEntry(entries);
      const packageDirectory = join(pluginDirectory, "packages", packageHash);
      const temporaryDirectory = join(
        pluginDirectory,
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
        message: `Installed plugin package ${input.fileName}.`,
      };
    },
  };
}

export function createNodePluginImporter(
  options: NodeAdapterPluginOptions = {},
): NonNullable<ZelavisPluginLoadOptions["importer"]> {
  const pluginDirectory = resolve(options.directory ?? ".zelavis/plugins");
  const allowRemote = options.allowRemote ?? true;

  return async (specifier) => {
    if (isDataSpecifier(specifier)) {
      return import(specifier);
    }

    if (isRemoteSpecifier(specifier)) {
      if (!allowRemote) {
        throw new Error("Remote plugin module specifiers are disabled.");
      }

      return importFilePath(await downloadRemotePlugin(specifier, pluginDirectory));
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

export function nodeAdapter(options: NodeAdapterOptions = {}) {
  return defineAdapter({
    name: "node",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (options.database !== false) {
        const databaseOptions = options.database ?? {};
        nextCoreServices.database = {
          defaultTenantId: databaseOptions.defaultTenantId,
          driver: createBetterSqlite3DatabaseDriver({
            filename: databaseOptions.filename
              ? resolve(databaseOptions.filename)
              : join(dataDirectory, "zelavis.sqlite"),
            readonly: databaseOptions.readonly,
            fileMustExist: databaseOptions.fileMustExist,
            defaultTenantId: databaseOptions.defaultTenantId,
            pragma: databaseOptions.pragma,
          }),
        };
      }

      if (options.dashboard !== false) {
        const dashboardOptions = options.dashboard ?? {};
        nextCoreServices.dashboard = {
          settingsStore: createFileDashboardSettingsStore(
            dashboardOptions.settingsFile
              ? resolve(dashboardOptions.settingsFile)
              : join(dataDirectory, "dashboard-settings.json"),
          ),
        };
      }

      const pluginOptions = options.plugins === false ? undefined : options.plugins;
      const pluginDirectory = join(dataDirectory, "plugins");
      const fileStorage =
        options.files === false
          ? undefined
          : createLocalFileStorage(
              options.files?.rootDirectory
                ? resolve(options.files.rootDirectory)
                : join(dataDirectory, "files"),
            );

      return {
        coreServices: nextCoreServices,
        plugins:
          options.plugins === false
            ? undefined
            : {
                importer: createNodePluginImporter({
                  directory: pluginDirectory,
                  ...(pluginOptions ?? {}),
                }),
                ...(fileStorage
                  ? { store: createFileStoragePluginRegistryStore(fileStorage) }
                  : {}),
              },
        resources: {
          kv: options.kv === false ? undefined : createMemoryKeyValueStore(),
          files: fileStorage,
          pluginPackages:
            options.plugins === false
              ? undefined
              : createNodePluginPackageInstaller({
                  directory: pluginDirectory,
                  ...(pluginOptions ?? {}),
                }),
        },
        metadata: {
          runtime: "node",
        },
      };
    },
  });
}
