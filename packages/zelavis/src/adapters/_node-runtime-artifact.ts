import { CURRENT_FORMAT } from "../db/format.js";
import { readFile, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { createRuntimeArtifactManifestDigest, defineRuntimeArtifact, type ZelavisRuntimeArtifactManifest } from "../core/artifact/index.js";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";
import { isExactVersion } from "../updates.js";
import { fileDigest } from "./_node-file-digest.js";
import {
  executableArtifactFiles,
  inventoryRuntimeArtifact,
  REQUIRED_RUNTIME_ARTIFACT_FILES,
  RUNTIME_ARTIFACT_MANIFEST,
  type VerifyReply,
  type VerifyRequest,
} from "./_node-runtime-hash-worker.js";

/**
 * The process's runtime verifier: one worker thread, made when first needed and kept, which runs the release inventory
 * walk, manifest check, and file hashing on its own event loop while remembering unchanged files it already verified
 * (see `_node-runtime-hash-worker.ts`). A worker that fails or exits fails what it was asked and is replaced by the
 * next request, empty. Each request is bounded by a deadline.
 */
const VERIFY_DEADLINE_MS = 300_000;
let verifier: { readonly worker: Worker; readonly pending: Map<number, (reply: VerifyReply) => void> } | undefined;
let nextRequest = 0;
const verifierWorker = () => {
  if (verifier) return verifier;
  const worker = new Worker(new URL("./_node-runtime-hash-worker.js", import.meta.url));
  const made = { worker, pending: new Map<number, (reply: VerifyReply) => void>() };
  const failAll = (error: string) => {
    if (verifier === made) verifier = undefined;
    for (const [id, resume] of made.pending) resume({ id, error });
    made.pending.clear();
  };
  worker.on("message", (reply: VerifyReply) => {
    const resume = made.pending.get(reply.id);
    if (!resume) return;
    made.pending.delete(reply.id);
    // Idle, the verifier never keeps the process alive.
    if (made.pending.size === 0) worker.unref();
    resume(reply);
  });
  worker.on("error", (cause: Error) => failAll(`The runtime artifact verifier failed: ${cause.message}`));
  worker.on("exit", code => failAll(`The runtime artifact verifier exited (${code}).`));
  worker.unref();
  verifier = made;
  return made;
};

/** One authored artifact manifest for staged and npm-assembled installations.
 * This is integrity within an HTTPS-acquired release, never a release signature.
 */
export const sealNodeRuntimeArtifact = Effect.fn("RuntimeArtifact.seal")(function* (directory: string) {
  const tree = yield* inventoryRuntimeArtifact(directory, false);
  yield* executableArtifactFiles(tree.root);
  const source = yield* integration(() => readFile(join(tree.root, "manifest.json"), "utf8"));
  const release = yield* evaluate(() => {
    const value = JSON.parse(source);
    if (value.name !== "zelavis" || !isExactVersion(value.version) || !["linux", "darwin"].includes(value.platform) || !["x64", "arm64"].includes(value.architecture) || typeof value.nodeVersion !== "string") throw new Error("Runtime artifact requires an exact Zelavis release and private Node.");
    for (const path of REQUIRED_RUNTIME_ARTIFACT_FILES) if (!tree.files.includes(path)) throw new Error(`Release lacks the handover engine: ${path}.`);
    return value;
  });
  const entries = yield* Effect.forEach(tree.files, path => fileDigest(join(tree.root, path)).pipe(Effect.map(digest => [path, digest] as const)), { concurrency: 8 });
  const packageSource = yield* integration(() => readFile(join(tree.root, "platform", "package.json"), "utf8"));
  const compatibilityDate = yield* evaluate(() => JSON.parse(packageSource).zelavis?.compatibilityDate as string | undefined);
  const input: ZelavisRuntimeArtifactManifest = { formatVersion: "ZELAVIS_RUNTIME_ARTIFACT_V1", name: `zelavis-${release.platform}-${release.architecture}`,
    version: release.version, runtime: "node", entrypoint: "bin/zelavis", files: tree.files, fileDigests: Object.fromEntries(entries),
    ...(compatibilityDate ? { compatibilityDate } : {}),
    metadata: { platform: release.platform, architecture: release.architecture, nodeVersion: release.nodeVersion, protocol: NODE_RUNTIME_PROTOCOL, dataFormat: CURRENT_FORMAT,
      edgeDefaultAdapter: "traefik", ...(release.edge?.traefikVersion ? { traefikVersion: release.edge.traefikVersion } : {}), links: tree.links } };
  const digest = yield* integration(() => createRuntimeArtifactManifestDigest(input));
  const artifact = yield* evaluate(() => defineRuntimeArtifact({ ...input, digest }));
  yield* integration(() => writeFile(join(tree.root, RUNTIME_ARTIFACT_MANIFEST), `${JSON.stringify(artifact)}\n`, { mode: 0o644 }));
  return artifact;
});

/** Verify a sealed release off this process's event loop so inventory walks and file hashing never contend with HTTP traffic. */
export const verifyNodeRuntimeArtifact = Effect.fn("RuntimeArtifact.verify")(function* (directory: string, expected: { readonly version: string; readonly digest?: string }, rootOwned = false) {
  const reply = yield* Effect.callback<VerifyReply>(resume => {
    const { worker, pending } = verifierWorker();
    const id = nextRequest++;
    pending.set(id, reply => resume(Effect.succeed(reply)));
    worker.ref();
    worker.postMessage({ id, directory, expected: { version: expected.version, ...(expected.digest !== undefined ? { digest: expected.digest } : {}) }, rootOwned } satisfies VerifyRequest);
    return Effect.sync(() => { pending.delete(id); if (pending.size === 0) worker.unref(); });
  }).pipe(Effect.timeoutOrElse({ duration: VERIFY_DEADLINE_MS, orElse: () => Effect.succeed<VerifyReply>({ id: -1, error: "Verifying the runtime artifact's files did not finish in time." }) }));
  if (reply.error !== undefined || reply.root === undefined || reply.release === undefined) {
    return yield* new IntegrationFailure(new Error(reply.error ?? "Verifying the runtime artifact failed."));
  }
  return { root: reply.root, release: reply.release };
});
