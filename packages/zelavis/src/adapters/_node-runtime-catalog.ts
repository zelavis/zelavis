import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Effect } from "effect";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { compareVersions, isExactVersion } from "../updates.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import type { NodeRuntimeExecution } from "./_node-runtime-supervisor.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";
import { verifyNodeRuntimeArtifact } from "./_node-runtime-artifact.js";

/** The installation's already acquired immutable releases. Acquisition and
 * permission to install host code remain with the existing installer/updater;
 * selecting a Project version never runs npm, sudo, or an arbitrary executable.
 */
export function createNodeRuntimeCatalog(options: { readonly directory: string; readonly rootOwned: boolean }) {
  const directory = resolve(options.directory);
  const exactDirectory = Effect.fn("RuntimeCatalog.exactDirectory")(function* (version: string) {
    yield* evaluate(() => { if (!isExactVersion(version)) throw new Error("Runtime engine selection requires an exact version."); });
    const root = yield* integration(() => realpath(directory));
    const tree = yield* integration(() => realpath(join(root, version)));
    if (tree !== join(root, version) || !tree.startsWith(`${root}${sep}`)) return yield* new IntegrationFailure(new Error("Runtime engine selection must name an immutable release directory, never a link or external path."));
    return tree;
  });
  const entry = Effect.fn("RuntimeCatalog.entry")(function* (version: string) {
    const tree = yield* exactDirectory(version);
    const file = join(tree, "runtime-artifact.json");
    const stats = yield* integration(() => lstat(file));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024 || options.rootOwned && (stats.uid !== 0 || (stats.mode & 0o022) !== 0)) return yield* new IntegrationFailure(new Error("Runtime engine catalog requires an installer-owned artifact manifest."));
    const source = yield* integration(() => readFile(file, "utf8"));
    return yield* evaluate(() => {
      const artifact = JSON.parse(source);
      if (artifact.version !== version || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.metadata?.protocol !== NODE_RUNTIME_PROTOCOL || artifact.metadata.platform !== process.platform || artifact.metadata.architecture !== process.arch || typeof artifact.metadata.nodeVersion !== "string") throw new Error("Runtime engine does not declare this host's exact handover protocol.");
      return { version, digest: artifact.digest as string, nodeVersion: artifact.metadata.nodeVersion as string };
    });
  });
  const catalog = {
    /** Advertised selections; execution always re-verifies every byte and link.
     * Invalid releases remain visible so operator repair has an explicit reason. */
    list: Effect.fn("RuntimeCatalog.list")(function* () {
      const directories = yield* integration(() => readdir(directory, { withFileTypes: true }));
      if (directories.length > 4096) return yield* new IntegrationFailure(new Error("Runtime catalog exceeds its entry bound."));
      const versions = directories.filter(value => value.isDirectory() && isExactVersion(value.name)).map(value => value.name).sort((a, b) => compareVersions(b, a));
      return yield* Effect.forEach(versions, version => Effect.result(entry(version)).pipe(Effect.map(result => result._tag === "Success"
        ? { ...result.success, status: "available" as const }
        : { version, status: "unavailable" as const, error: result.failure.message })), { concurrency: 4 });
    }),
    latest: Effect.fn("RuntimeCatalog.latest")(function* (): Effect.fn.Return<RuntimeRelease, IntegrationFailure> {
      const listed = yield* catalog.list();
      const latest = listed.find(entry => entry.status === "available");
      if (!latest) return yield* new IntegrationFailure(new Error("No qualified installed runtime engine is available."));
      return yield* catalog.select(latest.version);
    }),
    select: Effect.fn("RuntimeCatalog.select")(function* (version: string) {
      const advertised = yield* entry(version);
      const selected = yield* verifyNodeRuntimeArtifact(yield* exactDirectory(version), advertised, options.rootOwned);
      return selected.release;
    }),
    resolve: Effect.fn("RuntimeCatalog.resolve")(function* (selected: RuntimeRelease, role: "platform" | "project", configuration: Readonly<Record<string, unknown>>, environment: Readonly<Record<string, string>>): Effect.fn.Return<NodeRuntimeExecution, IntegrationFailure> {
      yield* evaluate(() => { if (role !== "platform" && role !== "project") throw new Error("Runtime engine role requires explicit Platform or Project authority."); });
      const verified = yield* verifyNodeRuntimeArtifact(yield* exactDirectory(selected.version), selected, options.rootOwned);
      return { executable: join(verified.root, "runtime", "node", "bin", "node"),
        worker: join(verified.root, "platform", "dist", "adapters", "_node-runtime-worker.js"),
        module: join(verified.root, "platform", "dist", "adapters", `_node-${role}-engine.js`),
        cwd: verified.root, environment, configuration };
    }),
  };
  return catalog;
}
