import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBlueprintRegistry,
  parseBlueprintManifest,
  type ZelavisBlueprintEntry,
  type ZelavisBlueprintRegistry,
} from "../blueprint.js";

export interface LocalBlueprintRegistryOptions {
  directory?: string;
  cacheDirectory?: string;
}

export function defaultShippedBlueprintDirectory(): string {
  return fileURLToPath(new URL("../../blueprints", import.meta.url));
}

async function findManifestPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    });

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === "blueprint.json") {
        paths.push(path);
      }
    }
  }

  await visit(directory);
  return paths.sort();
}

async function readEntries(
  directory: string,
  origin: ZelavisBlueprintEntry["origin"],
): Promise<ZelavisBlueprintEntry[]> {
  const manifestPaths = await findManifestPaths(directory);

  return Promise.all(
    manifestPaths.map(async (manifestPath) => ({
      manifest: parseBlueprintManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      ),
      directory: dirname(manifestPath),
      origin,
    })),
  );
}

export async function loadLocalBlueprintRegistry(
  options: LocalBlueprintRegistryOptions = {},
): Promise<ZelavisBlueprintRegistry> {
  const shippedDirectory = resolve(
    options.directory ?? defaultShippedBlueprintDirectory(),
  );
  const shipped = await readEntries(
    shippedDirectory,
    options.directory ? "custom" : "shipped",
  );
  const cached = options.cacheDirectory
    ? await readEntries(resolve(options.cacheDirectory), "cache")
    : [];
  const cachedIdentities = new Set(
    cached.map((entry) => `${entry.manifest.id}@${entry.manifest.version}`),
  );

  return createBlueprintRegistry([
    ...cached,
    ...shipped.filter(
      (entry) =>
        !cachedIdentities.has(`${entry.manifest.id}@${entry.manifest.version}`),
    ),
  ]);
}
