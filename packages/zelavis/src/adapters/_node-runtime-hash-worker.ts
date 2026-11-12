/**
 * The file hasher of one process: a worker thread with an event loop of its own, so verifying a release costs what reading
 * and hashing it costs, never the queue of a Platform's busy event loop (on a loaded host the same verification took 2.9 s
 * here and 142 s on the main loop). It answers one request at a time per message and keeps, for this process only, the files
 * it already hashed and found equal to their manifest digest with the stat fingerprint they had then: such a file is read
 * again only when its status changed. Nothing here is persisted or shared with another process; a restart starts empty.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describeFailure, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { fileDigest, fingerprintOf } from "./_node-file-digest.js";

const MAX_HASHED_FILES = 200_000;
const MAX_REQUEST_FILES = 100_000;
const hashedFiles = new Map<string, { readonly fingerprint: string; readonly digest: string }>();

export interface HashRequest {
  readonly id: number;
  readonly root: string;
  /** Paths relative to `root`, each with the digest its manifest names. */
  readonly files: ReadonlyArray<readonly [string, string]>;
}
export interface HashReply {
  readonly id: number;
  /** Absent when every file matched. */
  readonly error?: string;
}

const isRequest = (value: unknown): value is HashRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<HashRequest>;
  return Number.isSafeInteger(request.id) && typeof request.root === "string" && Array.isArray(request.files) &&
    request.files.length <= MAX_REQUEST_FILES &&
    request.files.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string");
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

const port = parentPort;
if (port) {
  port.on("message", (message: unknown) => {
    if (!isRequest(message)) {
      const id = typeof message === "object" && message !== null && Number.isSafeInteger((message as { id?: unknown }).id) ? (message as { id: number }).id : -1;
      port.postMessage({ id, error: "Malformed runtime hash request." } satisfies HashReply);
      return;
    }
    Effect.runFork(Effect.forEach(message.files, ([path, expected]) => verifyFile(message.root, path, expected), { concurrency: 8, discard: true }).pipe(
      Effect.exit,
      Effect.flatMap(exit => Effect.sync(() => port.postMessage((Exit.isSuccess(exit)
        ? { id: message.id }
        : { id: message.id, error: describeFailure(Cause.squash(exit.cause)) }) satisfies HashReply))),
    ));
  });
}
