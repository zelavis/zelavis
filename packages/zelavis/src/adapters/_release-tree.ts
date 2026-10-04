import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { evaluate, integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { sealNodeRuntimeArtifact } from "./_node-runtime-artifact.js";

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
interface NpmReleaseTreeOptions {
  readonly platform?: string;
  readonly architecture?: string;
  /** Tests only: the Node version the release pins, and the Traefik download. */
  readonly nodeVersion?: string;
  readonly installTraefik?: (output: string, version: string, target: { platform: string; architecture: string }, cacheRoot: string) => Promise<boolean>;
}
export function assembleNpmReleaseTree(prepared: string, options: NpmReleaseTreeOptions = {}): Promise<NpmReleaseTree> {
  return present(assembleNpmReleaseTreeProgram(prepared, options));
}
export const assembleNpmReleaseTreeProgram = Effect.fn("ReleaseTree.assemble")(function* (prepared: string, options: NpmReleaseTreeOptions = {}): Effect.fn.Return<NpmReleaseTree, TaggedFailure> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(architecture)) {
    return yield* new IntegrationFailure(new Error(`Unsupported installation target: ${platform}-${architecture}.`));
  }
  const configSource = yield* integration(() => readFile(assetPath("release.json"), "utf8"));
  const config = yield* evaluate(() => JSON.parse(configSource) as ReleaseConfig);
  const packageSource = yield* integration(() => readFile(join(prepared, "platform", "package.json"), "utf8"));
  const packageManifest = yield* evaluate(() => JSON.parse(packageSource) as { name?: unknown; version?: unknown });
  if (packageManifest.name !== "zelavis" || typeof packageManifest.version !== "string") return yield* new IntegrationFailure(new Error("The prepared tree does not hold the zelavis package."));

  const node = join(prepared, "runtime", "node", "bin", "node");
  const nodeStats = yield* integration(() => stat(node)).pipe(Effect.catchIf(error => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.void));
  if (!nodeStats?.isFile()) return yield* new IntegrationFailure(new Error("The prepared tree lacks its private Node binary."));
  // The installer must run on the Node the release will ship and pin.
  const nodeVersion = options.nodeVersion ?? config.nodeVersion;
  if ((yield* integration(() => realpath(node))) !== (yield* integration(() => realpath(process.execPath))) || process.versions.node !== nodeVersion) {
    return yield* new IntegrationFailure(new Error(`Install from the prepared private Node ${nodeVersion}, not ${process.execPath} (${process.version}).`));
  }

  (yield* integration(() => mkdir(join(prepared, "bin"), { recursive: true })));
  (yield* integration(() => copyFile(assetPath("zelavis-launcher"), join(prepared, "bin", "zelavis"))));
  (yield* integration(() => chmod(join(prepared, "bin", "zelavis"), 0o755)));
  (yield* integration(() => mkdir(join(prepared, "share"), { recursive: true })));
  const linux = platform === "linux";
  for (const file of ["zelavis.service", "zelavis@.service", "zelavis-agent.service", "zelavis-agent@.service", "zelavis-host-agent.service", "zelavis-host-agent@.service", "zelavis-update.service", "zelavis-update.path", "zelavis.socket", "uninstall.sh", ...linux ? ["zelavis-traefik.service", "traefik.yml"] : []]) {
    (yield* integration(() => copyFile(assetPath(`share/${file}`), join(prepared, "share", file))));
  }
  (yield* integration(() => chmod(join(prepared, "share", "uninstall.sh"), 0o755)));
  (yield* integration(() => cp(assetPath("operations"), join(prepared, "operations"), { recursive: true })));
  // npm transports normalize ordinary files to 0644. Restore the Agent's
  // executable-artifact contract when assembling the root-owned installed tree.
  for (const operation of (yield* integration(() => readdir(join(prepared, "operations"), { withFileTypes: true })))) {
    if (!operation.isDirectory()) continue;
    for (const version of (yield* integration(() => readdir(join(prepared, "operations", operation.name), { withFileTypes: true })))) {
      if (version.isDirectory()) (yield* integration(() => chmod(join(prepared, "operations", operation.name, version.name, "artifact"), 0o755)));
    }
  }

  let traefikBundled = false;
  if (linux) {
    traefikBundled = yield* Effect.acquireUseRelease(
      integration(() => mkdtemp(join(prepared, ".cache-"))),
      cache => Effect.gen(function* () {
        const installTraefik = options.installTraefik ?? ((yield* integration(() => import(new URL("runtime-assets.mjs", assets).href))) as {
          installTraefikRuntime(output: string, version: string, target: { platform: string; architecture: string }, cacheRoot: string): Promise<boolean>;
        }).installTraefikRuntime;
        return yield* integration(() => installTraefik(prepared, config.traefikVersion, { platform, architecture }, cache));
      }),
      cache => integration(() => rm(cache, { recursive: true, force: true })).pipe(Effect.orDie),
    );
  }

  (yield* integration(() => writeFile(join(prepared, "manifest.json"), `${JSON.stringify({
    schemaVersion: config.schemaVersion,
    name: "zelavis",
    version: packageManifest.version,
    nodeVersion,
    minimumNodeMajor: config.minimumNodeMajor,
    edge: { defaultAdapter: "traefik", traefikVersion: config.traefikVersion, bundled: traefikBundled },
    platform,
    architecture,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`)));
  yield* sealNodeRuntimeArtifact(prepared);
  return { version: packageManifest.version };
});
