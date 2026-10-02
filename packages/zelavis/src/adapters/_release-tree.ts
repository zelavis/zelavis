import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const assets = new URL("../installation-assets/", import.meta.url);
const assetPath = (name: string) => new URL(name, assets).pathname;

interface ReleaseConfig {
  readonly schemaVersion: number;
  readonly nodeVersion: string;
  readonly traefikVersion: string;
  readonly minimumNodeMajor: number;
}

export interface NpmReleaseTree {
  readonly version: string;
}

/**
 * Completes a release tree from the npm package alone.
 *
 * `prepared` holds what the bootstrap fetched: the private Node under
 * `runtime/node` and the installed package under `platform`. This adds what the
 * installer's shared plan reads from every release (launcher, unit templates,
 * host operations, the pinned Traefik on Linux and a manifest), taking each
 * from the package's own installation assets so there is one source for them.
 * The result has the layout a staged release has, so one plan installs both.
 */
export async function assembleNpmReleaseTree(prepared: string, options: {
  readonly platform?: string;
  readonly architecture?: string;
  /** Tests only: the Node version the release pins, and the Traefik download. */
  readonly nodeVersion?: string;
  readonly installTraefik?: (output: string, version: string, target: { platform: string; architecture: string }, cacheRoot: string) => Promise<boolean>;
} = {}): Promise<NpmReleaseTree> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported installation target: ${platform}-${architecture}.`);
  }
  const config = JSON.parse(await readFile(assetPath("release.json"), "utf8")) as ReleaseConfig;
  const packageManifest = JSON.parse(await readFile(join(prepared, "platform", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (packageManifest.name !== "zelavis" || typeof packageManifest.version !== "string") throw new Error("The prepared tree does not hold the zelavis package.");

  const node = join(prepared, "runtime", "node", "bin", "node");
  if (!(await stat(node).catch(() => undefined))?.isFile()) throw new Error("The prepared tree lacks its private Node binary.");
  // The installer must run on the Node the release will ship and pin.
  const nodeVersion = options.nodeVersion ?? config.nodeVersion;
  if (await realpath(node) !== await realpath(process.execPath) || process.versions.node !== nodeVersion) {
    throw new Error(`Install from the prepared private Node ${nodeVersion}, not ${process.execPath} (${process.version}).`);
  }

  await mkdir(join(prepared, "bin"), { recursive: true });
  await copyFile(assetPath("zelavis-launcher"), join(prepared, "bin", "zelavis"));
  await chmod(join(prepared, "bin", "zelavis"), 0o755);
  await mkdir(join(prepared, "share"), { recursive: true });
  const linux = platform === "linux";
  for (const file of ["zelavis.service", "zelavis@.service", "zelavis-agent.service", "zelavis-agent@.service", "zelavis-update.service", "zelavis-update.path", "uninstall.sh", ...linux ? ["zelavis-traefik.service", "traefik.yml"] : []]) {
    await copyFile(assetPath(`share/${file}`), join(prepared, "share", file));
  }
  await chmod(join(prepared, "share", "uninstall.sh"), 0o755);
  await cp(assetPath("operations"), join(prepared, "operations"), { recursive: true });

  let traefikBundled = false;
  if (linux) {
    const cache = await mkdtemp(join(prepared, ".cache-"));
    try {
      const installTraefik = options.installTraefik ?? (await import(new URL("runtime-assets.mjs", assets).href) as {
        installTraefikRuntime(output: string, version: string, target: { platform: string; architecture: string }, cacheRoot: string): Promise<boolean>;
      }).installTraefikRuntime;
      traefikBundled = await installTraefik(prepared, config.traefikVersion, { platform, architecture }, cache);
    } finally { await rm(cache, { recursive: true, force: true }); }
  }

  await writeFile(join(prepared, "manifest.json"), `${JSON.stringify({
    schemaVersion: config.schemaVersion,
    name: "zelavis",
    version: packageManifest.version,
    nodeVersion,
    minimumNodeMajor: config.minimumNodeMajor,
    edge: { defaultAdapter: "traefik", traefikVersion: config.traefikVersion, bundled: traefikBundled },
    platform,
    architecture,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { version: packageManifest.version };
}
