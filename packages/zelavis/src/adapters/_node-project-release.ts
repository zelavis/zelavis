import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { digestArtifactDirectory, loadRecipeArtifact } from "./_recipe-artifact.js";
import { evaluate, integration, unwrapFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import { ZELAVIS_VERSION } from "../version.js";
import { isExactVersion } from "../updates.js";

const flush = Effect.fn("ProjectRelease.flush")(function* (path: string, directory = false) {
  if (directory && process.platform === "win32") return;
  yield* Effect.acquireUseRelease(integration(() => open(path, "r")),
    handle => integration(() => handle.sync()), handle => integration(() => handle.close()).pipe(Effect.orDie));
});
const flushTree = Effect.fn("ProjectRelease.flushTree")(function* (path: string): Effect.fn.Return<void, TaggedFailure> {
  const stat = yield* integration(() => lstat(path));
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const names = yield* integration(() => readdir(path));
    yield* Effect.forEach(names, name => flushTree(join(path, name)), { concurrency: 1, discard: true });
  }
  yield* flush(path, stat.isDirectory());
});
const writeDescriptor = Effect.fn("ProjectRelease.writeDescriptor")(function* (directory: string, source: string) {
  const temporary = join(directory, `.project-${randomUUID()}.json`);
  yield* Effect.gen(function* () {
    yield* integration(() => writeFile(temporary, source, { mode: 0o600 }));
    yield* flush(temporary);
    yield* integration(() => rename(temporary, join(directory, "project.json")));
    yield* flush(directory, true);
  }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
});

export const nodeProjectReleaseDirectory = (directory: string, release: RuntimeRelease) => {
  if (!isExactVersion(release.version) || !/^sha256:[a-f0-9]{64}$/.test(release.digest)) throw new Error("Project release requires an exact version and snapshot digest.");
  return join(directory, ".zelavis", "runtime-releases", release.digest.slice(7));
};

/** Derived, immutable recipe and descriptor copies. The Project lock remains
 * authority; keeping both copies lets a candidate prepare without replacing
 * files still served by the previous owner or needed for rollback.
 */
export const freezeNodeProjectRelease = Effect.fn("ProjectRelease.freeze")(function* (directory: string, source = directory, version = ZELAVIS_VERSION) {
  yield* evaluate(() => { if (!isExactVersion(version)) throw new Error("Project release requires an exact version."); });
  const releases = join(directory, ".zelavis", "runtime-releases");
  const incoming = join(releases, `.incoming-${randomUUID()}`);
  yield* integration(() => mkdir(incoming, { recursive: true, mode: 0o700 }));
  return yield* Effect.gen(function* () {
    const descriptor = yield* integration(() => readFile(join(source, "project.json"), "utf8"));
    yield* integration(() => writeFile(join(incoming, "project.json"), descriptor, { mode: 0o600 }));
    yield* integration(() => cp(join(source, ".zelavis", "recipe", "package"), join(incoming, "recipe", "package"), { recursive: true, dereference: false, verbatimSymlinks: true }));
    const digest = yield* integration(() => digestArtifactDirectory(incoming));
    const release = { version, digest };
    const destination = yield* evaluate(() => nodeProjectReleaseDirectory(directory, release));
    yield* flushTree(incoming);
    // Rename refuses an existing nonempty snapshot. Verify that immutable copy
    // rather than replacing it while an engine may be reading it.
    yield* integration(() => rename(incoming, destination)).pipe(Effect.catch(error => Effect.gen(function* () {
      const existing = yield* integration(() => digestArtifactDirectory(destination));
      if (existing !== digest) return yield* error;
    })));
    yield* flush(releases, true);
    return release;
  }).pipe(Effect.ensuring(integration(() => rm(incoming, { recursive: true, force: true })).pipe(Effect.orDie)));
});

export const verifyNodeProjectRelease = Effect.fn("ProjectRelease.verify")(function* (directory: string, projectId: string, release: RuntimeRelease) {
  const snapshot = yield* evaluate(() => nodeProjectReleaseDirectory(directory, release));
  const digest = yield* integration(() => digestArtifactDirectory(snapshot));
  yield* evaluate(() => { if (digest !== release.digest) throw new Error("Project runtime snapshot no longer matches its locked digest."); });
  const source = yield* integration(() => readFile(join(snapshot, "project.json"), "utf8"));
  const record = yield* evaluate(() => {
    const value = JSON.parse(source);
    if (value.id !== projectId || typeof value.recipe?.name !== "string" || typeof value.recipe?.version !== "string" || typeof value.recipe?.artifact?.digest !== "string") throw new Error("Project release has a mismatched identity or recipe lock.");
    return value;
  });
  yield* integration(() => loadRecipeArtifact(snapshot, { name: record.recipe.name, version: record.recipe.version, digest: record.recipe.artifact.digest }));
  return { snapshot, record };
});

/** Canonical files are a presentation of the selected immutable snapshot.
 * Workers always load snapshots, so this swap cannot change a live worker's
 * code. Failed swaps restore the previous canonical recipe before returning.
 */
export const restoreNodeProjectRelease = Effect.fn("ProjectRelease.restore")(function* (directory: string, projectId: string, release: RuntimeRelease) {
  const { snapshot, record } = yield* verifyNodeProjectRelease(directory, projectId, release);
  const previousDescriptor = yield* integration(() => readFile(join(directory, "project.json"), "utf8"));
  const canonical = join(directory, ".zelavis", "recipe");
  const incoming = `${canonical}.incoming-${randomUUID()}`, backup = `${canonical}.previous-${randomUUID()}`;
  const hadCanonical = yield* integration(() => lstat(canonical)).pipe(Effect.as(true),
    Effect.catchIf(error => (unwrapFailure(error) as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(false)));
  yield* Effect.uninterruptible(Effect.gen(function* () {
    yield* integration(() => cp(join(snapshot, "recipe"), incoming, { recursive: true, verbatimSymlinks: true }));
    yield* flushTree(incoming);
    if (hadCanonical) yield* integration(() => rename(canonical, backup));
    yield* integration(() => rename(incoming, canonical)).pipe(Effect.onError(() => hadCanonical
      ? integration(() => rename(backup, canonical)).pipe(Effect.orDie) : Effect.void));
    yield* Effect.gen(function* () {
      yield* flush(dirname(canonical), true);
      yield* writeDescriptor(directory, `${JSON.stringify(record)}\n`);
    }).pipe(Effect.onError(() => Effect.gen(function* () {
      yield* integration(() => rm(canonical, { recursive: true, force: true }));
      if (hadCanonical) yield* integration(() => rename(backup, canonical));
      yield* flush(dirname(canonical), true);
      yield* writeDescriptor(directory, previousDescriptor);
    }).pipe(Effect.orDie)));
    yield* integration(() => rm(backup, { recursive: true, force: true }));
    yield* flush(dirname(canonical), true);
  })).pipe(Effect.ensuring(integration(() => rm(incoming, { recursive: true, force: true })).pipe(Effect.orDie)));
  return record;
});
