import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import { createRuntimeArtifactManifestDigest, defineRuntimeArtifact, type ZelavisRuntimeArtifactManifest } from "../core/artifact/index.js";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";
import { isExactVersion } from "../updates.js";

const ARTIFACT = "runtime-artifact.json";
const required = ["bin/zelavis", "platform/package.json", "runtime/node/bin/node",
  "platform/dist/adapters/_node-runtime-worker.js", "platform/dist/adapters/_node-runtime-protocol.js",
  "platform/dist/adapters/_node-platform-engine.js", "platform/dist/adapters/_node-project-engine.js"];
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const executableFiles = Effect.fn("RuntimeArtifact.executables")(function* (root: string) {
  for (const name of ["bin/zelavis", "runtime/node/bin/node"]) {
    const stats = yield* integration(() => lstat(join(root, name)));
    if (!stats.isFile() || (stats.mode & 0o111) !== 0o111) return yield* new IntegrationFailure(new Error(`Runtime artifact requires an executable regular file: ${name}.`));
  }
});

const fileDigest = Effect.fn("RuntimeArtifact.fileDigest")(function* (path: string) {
  return yield* Effect.callback<`sha256:${string}`, IntegrationFailure>(resume => {
    const hash = createHash("sha256"), stream = createReadStream(path);
    let bytes = 0;
    stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) { stream.destroy(new Error("Runtime artifact file exceeds its size bound.")); return; }
      hash.update(chunk);
    });
    stream.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
    stream.once("end", () => resume(Effect.succeed(`sha256:${hash.digest("hex")}` as const)));
    return Effect.sync(() => { stream.destroy(); });
  });
});

/** Enumerate all bytes and the complete dependency-link graph. A digest which
 * ignores node_modules symlinks does not pin the code Node will actually load.
 * Absolute/escaping/broken links and special files are always refused.
 */
const inventory = Effect.fn("RuntimeArtifact.inventory")(function* (directory: string, rootOwned: boolean) {
  const root = yield* integration(() => realpath(directory));
  const files: string[] = [], links: Record<string, string> = {};
  let count = 0;
  const visit = Effect.fn("RuntimeArtifact.visit")(function* (path: string, depth: number): Effect.fn.Return<void, IntegrationFailure> {
    if (depth > 64 || ++count > 100_000) return yield* new IntegrationFailure(new Error("Runtime artifact exceeds its inventory bound."));
    const stats = yield* integration(() => lstat(path));
    if (rootOwned && (stats.uid !== 0 || !stats.isSymbolicLink() && (stats.mode & 0o022) !== 0)) return yield* new IntegrationFailure(new Error("System runtime artifacts must be root-owned and not group/world-writable."));
    const name = relative(root, path).split(sep).join("/");
    if (stats.isSymbolicLink()) {
      const target = yield* integration(() => readlink(path));
      const destination = yield* integration(() => realpath(path));
      if (target.startsWith("/") || !within(root, destination)) return yield* new IntegrationFailure(new Error(`Runtime artifact link ${name} escapes its immutable tree.`));
      links[name] = target;
    } else if (stats.isDirectory()) {
      const entries = yield* integration(() => readdir(path));
      yield* Effect.forEach(entries.sort(), entry => entry === ARTIFACT && path === root ? Effect.void : visit(join(path, entry), depth + 1), { concurrency: 1, discard: true });
    } else if (stats.isFile()) files.push(name);
    else return yield* new IntegrationFailure(new Error(`Runtime artifact contains a special file: ${name}.`));
  });
  yield* visit(root, 0);
  return { root, files: files.sort(), links };
});

/** One authored artifact manifest for staged and npm-assembled installations.
 * This is integrity within an HTTPS-acquired release, never a release signature.
 */
export const sealNodeRuntimeArtifact = Effect.fn("RuntimeArtifact.seal")(function* (directory: string) {
  const tree = yield* inventory(directory, false);
  yield* executableFiles(tree.root);
  const source = yield* integration(() => readFile(join(tree.root, "manifest.json"), "utf8"));
  const release = yield* evaluate(() => {
    const value = JSON.parse(source);
    if (value.name !== "zelavis" || !isExactVersion(value.version) || !["linux", "darwin"].includes(value.platform) || !["x64", "arm64"].includes(value.architecture) || typeof value.nodeVersion !== "string") throw new Error("Runtime artifact requires an exact Zelavis release and private Node.");
    for (const path of required) if (!tree.files.includes(path)) throw new Error(`Release lacks the handover engine: ${path}.`);
    return value;
  });
  const entries = yield* Effect.forEach(tree.files, path => fileDigest(join(tree.root, path)).pipe(Effect.map(digest => [path, digest] as const)), { concurrency: 8 });
  const packageSource = yield* integration(() => readFile(join(tree.root, "platform", "package.json"), "utf8"));
  const compatibilityDate = yield* evaluate(() => JSON.parse(packageSource).zelavis?.compatibilityDate as string | undefined);
  const input: ZelavisRuntimeArtifactManifest = { formatVersion: "ZELAVIS_RUNTIME_ARTIFACT_V1", name: `zelavis-${release.platform}-${release.architecture}`,
    version: release.version, runtime: "node", entrypoint: "bin/zelavis", files: tree.files, fileDigests: Object.fromEntries(entries),
    ...(compatibilityDate ? { compatibilityDate } : {}),
    metadata: { platform: release.platform, architecture: release.architecture, nodeVersion: release.nodeVersion, protocol: NODE_RUNTIME_PROTOCOL,
      edgeDefaultAdapter: "traefik", ...(release.edge?.traefikVersion ? { traefikVersion: release.edge.traefikVersion } : {}), links: tree.links } };
  const digest = yield* integration(() => createRuntimeArtifactManifestDigest(input));
  const artifact = yield* evaluate(() => defineRuntimeArtifact({ ...input, digest }));
  yield* integration(() => writeFile(join(tree.root, ARTIFACT), `${JSON.stringify(artifact)}\n`, { mode: 0o644 }));
  return artifact;
});

export const verifyNodeRuntimeArtifact = Effect.fn("RuntimeArtifact.verify")(function* (directory: string, expected: { readonly version: string; readonly digest?: string }, rootOwned = false) {
  const tree = yield* inventory(directory, rootOwned);
  yield* executableFiles(tree.root);
  const manifestPath = join(tree.root, ARTIFACT);
  const stats = yield* integration(() => lstat(manifestPath));
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024 || rootOwned && (stats.uid !== 0 || (stats.mode & 0o022) !== 0)) return yield* new IntegrationFailure(new Error("Invalid immutable runtime artifact manifest."));
  const source = yield* integration(() => readFile(manifestPath, "utf8"));
  const artifact = yield* evaluate(() => defineRuntimeArtifact(JSON.parse(source)));
  yield* evaluate(() => {
    if (!isExactVersion(expected.version) || artifact.version !== expected.version || artifact.runtime !== "node" || artifact.metadata?.protocol !== NODE_RUNTIME_PROTOCOL || !artifact.digest || !artifact.fileDigests || artifact.signature) throw new Error("Release does not implement the qualified exact Zelavis handover protocol.");
    if (artifact.metadata.platform !== process.platform || artifact.metadata.architecture !== process.arch) throw new Error("Runtime artifact targets a different host.");
    if (expected.digest && expected.digest !== artifact.digest) throw new Error("Runtime artifact differs from its exact engine lock.");
    if (JSON.stringify(artifact.files) !== JSON.stringify(tree.files) || JSON.stringify(artifact.metadata.links) !== JSON.stringify(tree.links)) throw new Error("Runtime artifact file or dependency-link inventory has changed.");
    for (const path of required) if (!artifact.files.includes(path)) throw new Error(`Runtime artifact lacks ${path}.`);
  });
  const digest = yield* integration(() => createRuntimeArtifactManifestDigest(artifact));
  if (digest !== artifact.digest) return yield* new IntegrationFailure(new Error("Runtime artifact manifest digest mismatch."));
  yield* Effect.forEach(tree.files, path => Effect.gen(function* () {
    const actual = yield* fileDigest(join(tree.root, path));
    if (actual !== artifact.fileDigests![path]) return yield* new IntegrationFailure(new Error(`Runtime artifact file digest mismatch: ${path}.`));
  }), { concurrency: 8, discard: true });
  // Package identity and Node pin are covered by the digest, but must also
  // agree with the semantic engine selection rather than just its file list.
  const packageSource = yield* integration(() => readFile(join(tree.root, "platform", "package.json"), "utf8"));
  yield* evaluate(() => { const value = JSON.parse(packageSource); if (value.name !== "zelavis" || value.version !== expected.version) throw new Error("Engine package identity differs from its locked release."); });
  return { root: tree.root, release: { version: expected.version, digest: artifact.digest }, artifact };
});
