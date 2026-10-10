import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

/**
 * Reading a .zip with nothing but Node: no `unzip` on the host, no dependency.
 *
 * Only what release archives use is understood, and everything else is refused rather than guessed: stored
 * and deflated entries, no encryption, no zip64, no links or special files. Names are checked before anything is
 * written, sizes are checked as bytes arrive (an entry can neither grow past what it declared nor past the limits),
 * and every entry's CRC-32 must match, so a damaged or tampered archive fails instead of unpacking.
 */

export interface ZipEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly executable: boolean;
  readonly offset: number;
}

export class ZipError extends Data.TaggedError("ZipError")<{ readonly message: string }> {}

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const unreadable = () => new ZipError({ message: "The archive could not be read." });

/** A file opened for reading, closed however the work ends. */
const withFile = <A>(file: string, use: (handle: FileHandle) => Effect.Effect<A, ZipError>) =>
  Effect.acquireUseRelease(
    integration(() => open(file, "r")).pipe(Effect.mapError(unreadable)),
    use,
    (handle) => integration(() => handle.close()).pipe(Effect.orDie),
  );

const readAt = (handle: FileHandle, length: number, position: number) => {
  const buffer = Buffer.alloc(length);
  return integration(() => handle.read(buffer, 0, length, position)).pipe(
    Effect.map(({ bytesRead }) => buffer.subarray(0, bytesRead)),
    Effect.mapError(unreadable),
  );
};

/** Every entry of the archive, validated; fails with a ZipError naming the problem. */
export const readZipEntries = Effect.fn("RecipeZip.read")(function* (file: string, limits: { readonly entries: number; readonly bytes: number }) {
  return yield* withFile(file, (handle) => Effect.gen(function* () {
    const { size } = yield* integration(() => handle.stat()).pipe(Effect.mapError(unreadable));
    if (size < 22) return yield* new ZipError({ message: "The archive is too small to be a zip." });
    const tailLength = Math.min(size, 22 + MAX_COMMENT);
    const tail = yield* readAt(handle, tailLength, size - tailLength);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD) { end = at; break; }
    }
    if (end < 0) return yield* new ZipError({ message: "The archive has no end-of-archive record." });
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return yield* new ZipError({ message: "zip64 archives are not supported." });
    if (count === 0 || count > limits.entries) return yield* new ZipError({ message: "The archive is empty or holds too many entries." });
    if (directoryOffset + directorySize > size) return yield* new ZipError({ message: "The archive's directory lies outside the file." });
    const directory = yield* readAt(handle, directorySize, directoryOffset);
    if (directory.length !== directorySize) return yield* new ZipError({ message: "The archive's directory is damaged." });

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let total = 0, at = 0;
    for (let index = 0; index < count; index += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) return yield* new ZipError({ message: "The archive's directory is damaged." });
      const madeBy = directory.readUInt16LE(at + 4), flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16), compressedSize = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38), offset = directory.readUInt32LE(at + 42);
      if (at + 46 + nameLength > directory.length) return yield* new ZipError({ message: "The archive's directory is damaged." });
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;

      if ((flags & 1) !== 0) return yield* new ZipError({ message: "The archive is encrypted." });
      if (method !== 0 && method !== 8) return yield* new ZipError({ message: `The archive uses a compression method (${method}) that is not supported.` });
      if (compressedSize === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) return yield* new ZipError({ message: "zip64 archives are not supported." });
      if (name.length === 0 || name.length > 1024 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
        return yield* new ZipError({ message: "The archive names a path outside its destination." });
      }
      // Made on Unix (3): the upper half of the external attributes is the file mode. Links and special files are refused.
      let executable = false;
      if ((madeBy >> 8) === 3) {
        const mode = external >>> 16, type = mode & 0o170000;
        if (type !== 0 && type !== 0o100000 && type !== 0o040000) return yield* new ZipError({ message: "The archive holds a link or a special file, which is not allowed." });
        executable = (mode & 0o111) !== 0;
      }
      const clean = name.replace(/^\.\//, "");
      if (seen.has(clean)) return yield* new ZipError({ message: "The archive names a path twice." });
      seen.add(clean);
      total += uncompressed;
      if (total > limits.bytes) return yield* new ZipError({ message: "The archive unpacks to more than is allowed." });
      entries.push({ name: clean, directory: name.endsWith("/"), method, crc, compressedSize, size: uncompressed, executable, offset });
    }
    return entries as readonly ZipEntry[];
  }));
});

/** Counts the bytes that pass and refuses more than the entry declared; checks the CRC-32 at the end. */
function verifying(entry: ZipEntry) {
  let received = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > entry.size) { done(new Error(`"${entry.name}" is larger than it declared.`)); return; }
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
    flush(done) {
      if (received !== entry.size || crc >>> 0 !== entry.crc) done(new Error(`"${entry.name}" is damaged.`));
      else done();
    },
  });
}

/** Unpacks the entries below `destination` (which must exist), creating directories as needed. */
export const extractZipEntries = Effect.fn("RecipeZip.extract")(function* (file: string, entries: readonly ZipEntry[], destination: string) {
  const damaged = (name: string) => (cause: { readonly cause: unknown }) =>
    new ZipError({ message: cause.cause instanceof Error ? cause.cause.message : `"${name}" could not be unpacked.` });
  return yield* withFile(file, (handle) => Effect.forEach(entries, (entry) => Effect.gen(function* () {
    const target = join(destination, entry.name);
    if (entry.directory) { yield* integration(() => mkdir(target, { recursive: true, mode: 0o755 })).pipe(Effect.mapError(damaged(entry.name))); return; }
    yield* integration(() => mkdir(dirname(target), { recursive: true, mode: 0o755 })).pipe(Effect.mapError(damaged(entry.name)));
    const mode = entry.executable ? 0o755 : 0o644;
    if (entry.compressedSize === 0) {
      if (entry.size !== 0) return yield* new ZipError({ message: `"${entry.name}" is damaged.` });
      yield* integration(() => writeFile(target, "", { flag: "wx", mode })).pipe(Effect.mapError(damaged(entry.name)));
      return;
    }
    const local = yield* readAt(handle, 30, entry.offset);
    if (local.length < 30 || local.readUInt32LE(0) !== LOCAL) return yield* new ZipError({ message: `"${entry.name}" has no local header.` });
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    yield* integration(() => pipeline(
      createReadStream(file, { start, end: start + entry.compressedSize - 1 }),
      ...(entry.method === 8 ? [createInflateRaw()] : []),
      verifying(entry),
      createWriteStream(target, { flags: "wx", mode }),
    )).pipe(Effect.mapError(damaged(entry.name)));
  }), { concurrency: 1, discard: true }));
});
