import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";

/** The largest file a release may hold. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Files at most this large are read in one exactly sized buffer; larger ones stream. A release is mostly small files, and
 * a 1 MiB stream buffer per file spends the time allocating rather than hashing. */
export const WHOLE_READ_BYTES = 8 * 1024 * 1024;

/** Everything about a file that a write, rename, chmod or replacement changes (ctime cannot be set back by a program). */
export const fingerprintOf = (stats: BigIntStats) =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.mode}:${stats.uid}:${stats.gid}:${stats.nlink}`;

/** The digest of a file whose size was just read: exactly `size` bytes, or a failure if it holds more or fewer. */
const wholeFileDigest = Effect.fn("FileDigest.whole")(function* (path: string, size: number) {
  const handle = yield* integration(() => open(path, "r"));
  return yield* Effect.gen(function* () {
    // One byte more than expected, so a file that grew since its size was read is caught rather than cut short.
    const buffer = Buffer.allocUnsafe(size + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = yield* integration(() => handle.read(buffer, filled, buffer.length - filled, filled));
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled === buffer.length) break;
    }
    if (filled !== size) return yield* new IntegrationFailure(new Error(`Runtime artifact file changed while it was read: ${path}.`));
    return `sha256:${createHash("sha256").update(buffer.subarray(0, size)).digest("hex")}` as const;
  }).pipe(Effect.ensuring(integration(() => handle.close()).pipe(Effect.orDie)));
});

const streamedFileDigest = Effect.fn("FileDigest.stream")(function* (path: string) {
  return yield* Effect.callback<`sha256:${string}`, IntegrationFailure>(resume => {
    const hash = createHash("sha256"), stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    let bytes = 0;
    stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) { stream.destroy(new Error("Runtime artifact file exceeds its size bound.")); return; }
      hash.update(chunk);
    });
    stream.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
    stream.once("end", () => resume(Effect.succeed(`sha256:${hash.digest("hex")}` as const)));
    return Effect.sync(() => { stream.destroy(); });
  });
});

/** A file's SHA-256: read whole when its size is known and small, streamed otherwise. */
export const fileDigest = Effect.fn("FileDigest.digest")(function* (path: string, size?: number) {
  if (size !== undefined && size <= WHOLE_READ_BYTES) return yield* wholeFileDigest(path, size);
  return yield* streamedFileDigest(path);
});
