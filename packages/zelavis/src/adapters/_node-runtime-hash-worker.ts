/**
 * The runtime artifact verifier of one process: a worker thread with an event loop of its own, so verifying a release
 * (inventory walk, manifest check, and file hashing) costs what reading and hashing it costs, never the queue of a
 * Platform's busy event loop (on a loaded host the same verification took ~3 s here and 75-142 s on the main loop).
 * It keeps, for this process only, the files it already hashed and found equal to their manifest digest with the stat
 * fingerprint they had then: such a file is read again only when its status changed. Nothing here is persisted or
 * shared with another process; a restart starts empty.
 */
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parentPort } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { createRuntimeArtifactManifestDigest, defineRuntimeArtifact } from "../core/artifact/index.js";
import { describeFailure, evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { isExactVersion } from "../updates.js";
import { fileDigest, fingerprintOf } from "./_node-file-digest.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";

export const RUNTIME_ARTIFACT_MANIFEST = "runtime-artifact.json";
export const REQUIRED_RUNTIME_ARTIFACT_FILES = [
  "bin/zelavis", "platform/package.json", "runtime/node/bin/node",
  "platform/dist/adapters/_node-runtime-worker.js", "platform/dist/adapters/_node-runtime-protocol.js",
  "platform/dist/adapters/_node-platform-engine.js", "platform/dist/adapters/_node-project-engine.js",
] as const;

const MAX_HASHED_FILES = 200_000;
const hashedFiles = new Map<string, { readonly fingerprint: string; readonly digest: string }>();
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

export const executableArtifactFiles = Effect.fn("RuntimeArtifact.executables")(function* (root: string) {
  for (const name of ["bin/zelavis", "runtime/node/bin/node"]) {
    const stats = yield* integration(() => lstat(join(root, name)));
    if (!stats.isFile() || (stats.mode & 0o111) !== 0o111) return yield* new IntegrationFailure(new Error(`Runtime artifact requires an executable regular file: ${name}.`));
  }
});

/** Enumerate all bytes and the complete dependency-link graph. A digest which
 * ignores node_modules symlinks does not pin the code Node will actually load.
 * Absolute/escaping/broken links and special files are always refused.
 */
export const inventoryRuntimeArtifact = Effect.fn("RuntimeArtifact.inventory")(function* (directory: string, rootOwned: boolean) {
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
      yield* Effect.forEach(entries.sort(), entry => entry === RUNTIME_ARTIFACT_MANIFEST && path === root ? Effect.void : visit(join(path, entry), depth + 1), { concurrency: 1, discard: true });
    } else if (stats.isFile()) files.push(name);
    else return yield* new IntegrationFailure(new Error(`Runtime artifact contains a special file: ${name}.`));
  });
  yield* visit(root, 0);
  return { root, files: files.sort(), links };
});

export interface VerifyRequest {
  readonly id: number;
  readonly directory: string;
  readonly expected: { readonly version: string; readonly digest?: string };
  readonly rootOwned: boolean;
}
export interface VerifyReply {
  readonly id: number;
  readonly root?: string;
  readonly release?: { readonly version: string; readonly digest: `sha256:${string}` };
  /** Absent when every check matched. */
  readonly error?: string;
}

const isRequest = (value: unknown): value is VerifyRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<VerifyRequest>;
  return Number.isSafeInteger(request.id) &&
    typeof request.directory === "string" &&
    typeof request.rootOwned === "boolean" &&
    typeof request.expected === "object" && request.expected !== null &&
    typeof request.expected.version === "string" &&
    (request.expected.digest === undefined || typeof request.expected.digest === "string");
};

const verifyFile = Effect.fn("RuntimeHasher.file")(function* (root: string, path: string, expected: string) {
  const full = join(root, path);
  const stats = yield* integration(() => lstat(full, { bigint: true }));
  const before = fingerprintOf(stats);
  const known = hashedFiles.get(full);
  if (known !== undefined && known.fingerprint === before && known.digest === expected) return;
  const actual = yield* fileDigest(full, Number(stats.size));
  if (actual !== expected) return yield* new IntegrationFailure(new Error(`Runtime artifact file digest mismatch: ${path}.`));
  // Remembered only if the file did not change while it was read.
  const after = fingerprintOf(yield* integration(() => lstat(full, { bigint: true })));
  if (after === before) {
    if (hashedFiles.size >= MAX_HASHED_FILES) hashedFiles.clear();
    hashedFiles.set(full, { fingerprint: after, digest: actual });
  }
});

const verifyArtifact = Effect.fn("RuntimeVerifier.verify")(function* (request: VerifyRequest) {
  const tree = yield* inventoryRuntimeArtifact(request.directory, request.rootOwned);
  yield* executableArtifactFiles(tree.root);
  const manifestPath = join(tree.root, RUNTIME_ARTIFACT_MANIFEST);
  const stats = yield* integration(() => lstat(manifestPath));
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024 || request.rootOwned && (stats.uid !== 0 || (stats.mode & 0o022) !== 0)) {
    return yield* new IntegrationFailure(new Error("Invalid immutable runtime artifact manifest."));
  }
  const source = yield* integration(() => readFile(manifestPath, "utf8"));
  const artifact = yield* evaluate(() => defineRuntimeArtifact(JSON.parse(source)));
  yield* evaluate(() => {
    if (!isExactVersion(request.expected.version) || artifact.version !== request.expected.version || artifact.runtime !== "node" || artifact.metadata?.protocol !== NODE_RUNTIME_PROTOCOL || !artifact.digest || !artifact.fileDigests || artifact.signature) throw new Error("Release does not implement the qualified exact Zelavis handover protocol.");
    if (artifact.metadata.platform !== process.platform || artifact.metadata.architecture !== process.arch) throw new Error("Runtime artifact targets a different host.");
    if (request.expected.digest && request.expected.digest !== artifact.digest) throw new Error("Runtime artifact differs from its exact engine lock.");
    if (JSON.stringify(artifact.files) !== JSON.stringify(tree.files) || JSON.stringify(artifact.metadata.links) !== JSON.stringify(tree.links)) throw new Error("Runtime artifact file or dependency-link inventory has changed.");
    for (const path of REQUIRED_RUNTIME_ARTIFACT_FILES) if (!artifact.files.includes(path)) throw new Error(`Runtime artifact lacks ${path}.`);
  });
  const digest = yield* integration(() => createRuntimeArtifactManifestDigest(artifact));
  if (digest !== artifact.digest) return yield* new IntegrationFailure(new Error("Runtime artifact manifest digest mismatch."));
  yield* Effect.forEach(tree.files, path => verifyFile(tree.root, path, artifact.fileDigests![path]!), { concurrency: 8, discard: true });
  // Package identity and Node pin are covered by the digest, but must also
  // agree with the semantic engine selection rather than just its file list.
  const packageSource = yield* integration(() => readFile(join(tree.root, "platform", "package.json"), "utf8"));
  yield* evaluate(() => { const value = JSON.parse(packageSource); if (value.name !== "zelavis" || value.version !== request.expected.version) throw new Error("Engine package identity differs from its locked release."); });
  return { root: tree.root, release: { version: request.expected.version, digest: artifact.digest as `sha256:${string}` } };
});

const port = parentPort;
if (port) {
  port.on("message", (message: unknown) => {
    if (!isRequest(message)) {
      const id = typeof message === "object" && message !== null && Number.isSafeInteger((message as { id?: unknown }).id) ? (message as { id: number }).id : -1;
      port.postMessage({ id, error: "Malformed runtime verification request." } satisfies VerifyReply);
      return;
    }
    Effect.runFork(verifyArtifact(message).pipe(
      Effect.exit,
      Effect.flatMap(exit => Effect.sync(() => port.postMessage((Exit.isSuccess(exit)
        ? { id: message.id, root: exit.value.root, release: exit.value.release }
        : { id: message.id, error: describeFailure(Cause.squash(exit.cause)) }) satisfies VerifyReply))),
    ));
  });
}
