import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { arch, platform as osPlatform } from "node:os";
import { join, sep } from "node:path";
import { Effect, Semaphore } from "effect";
import { RecipeError, type RecipeManifest } from "../core/recipe/index.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { isRecord, parseJson } from "../core/json-validation.js";
import { createRecipeHost } from "./_recipe-host.js";

/**
 * The programs a recipe brings with it (its manifest's `runtimes`), made available as commands.
 *
 * Each is one pinned download per platform, verified against its SHA-256 and unpacked once into the
 * Platform's store under a name made from that digest. Two Projects pinning the same build share one
 * read-only copy; a Project pinning another version simply has another. Nothing is installed on the
 * host, nothing is shared with it, and an unpack that is interrupted leaves nothing behind that could
 * be mistaken for a complete one (the host's extraction renames a finished tree into place).
 */

export type RecipeRuntimes = NonNullable<RecipeManifest["runtimes"]>;

/** The platform name the manifest uses for this host, or nothing when it is not one of those offered. */
export function runtimePlatform(system: string = osPlatform(), architecture: string = arch()): string | undefined {
  const family = system === "linux" ? "linux" : system === "darwin" ? "macos" : undefined;
  const cpu = architecture === "x64" ? "x86_64" : architecture === "arm64" ? "aarch64" : undefined;
  return family && cpu ? `${family}-${cpu}` : undefined;
}

const fail = (message: string) => new RecipeError({ operation: "install", message });

/** Acquisitions into one store run one at a time, so two Projects wanting the same build download it once. */
const gates = new Map<string, Semaphore.Semaphore>();
const gateOf = (store: string) => {
  let gate = gates.get(store);
  if (!gate) { gate = Semaphore.makeUnsafe(1); gates.set(store, gate); }
  return gate;
};

const isExecutable = (path: string) => integration(() => stat(path)).pipe(
  Effect.map((entry) => entry.isFile() && (entry.mode & 0o111) !== 0),
  Effect.orElseSucceed(() => false),
);

/**
 * Command name to the absolute path of its program, for every runtime of the manifest. Fails, naming
 * the command and the platform, when a runtime has no build for this host.
 */
export const acquireRuntimes = Effect.fn("RecipeRuntimes.acquire")(function* (input: {
  readonly runtimes: RecipeRuntimes | undefined;
  readonly store: string;
  readonly platform?: string | undefined;
  readonly fetch?: typeof fetch;
}) {
  const commands: Record<string, string> = {};
  const wanted = input.runtimes ?? [];
  if (wanted.length === 0) return commands;
  const platform = input.platform ?? runtimePlatform();
  if (platform === undefined) return yield* Effect.fail(fail("This host's platform has no pinned runtime builds."));
  yield* integration(() => mkdir(input.store, { recursive: true, mode: 0o755 })).pipe(Effect.mapError(() => fail("The runtime store could not be created.")));
  return yield* gateOf(input.store).withPermit(Effect.gen(function* () {
    for (const runtime of wanted) {
      const download = runtime.downloads[platform];
      if (download === undefined) return yield* Effect.fail(fail(`${runtime.command} ${runtime.version} has no build for ${platform}.`));
      const folder = download.sha256;
      const program = join(input.store, folder, download.executable);
      if (!(yield* isExecutable(program))) {
        const host = createRecipeHost({ root: input.store, secretsDirectory: join(input.store, ".no-secrets"), commands: {}, allowContainedLinks: true, ...(input.fetch ? { fetch: input.fetch } : {}) });
        const archive = `${folder}.download.tar.gz`;
        // Whatever an earlier attempt left is not trusted, and not merged into.
        yield* host.files.remove(folder);
        yield* host.files.remove(archive);
        // The official origin first, then each mirror; a copy that differs fails its digest like any other failure.
        const sources = [download.archive, ...(download.mirrors ?? [])];
        const failures: string[] = [];
        let fetched = false;
        for (const url of sources) {
          const attempt = yield* host.download({ url, sha256: download.sha256, maxBytes: download.maxBytes, destination: archive }).pipe(Effect.result);
          if (attempt._tag === "Success") { fetched = true; break; }
          failures.push(`${new URL(url).host}: ${attempt.failure.message}`);
          yield* host.files.remove(archive);
        }
        if (!fetched) return yield* Effect.fail(fail(`${runtime.command} ${runtime.version} could not be downloaded: ${failures.join("; ")}`));
        yield* host.extract(archive, folder).pipe(
          Effect.ensuring(host.files.remove(archive).pipe(Effect.orElseSucceed(() => undefined))),
          Effect.mapError((error) => fail(`${runtime.command} ${runtime.version} could not be unpacked: ${error.message}`)));
        if (!(yield* isExecutable(program))) {
          // The archive did not hold the program it was pinned for: nothing of it is kept.
          yield* integration(() => rm(join(input.store, folder), { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined));
          return yield* Effect.fail(fail(`${runtime.command} ${runtime.version}'s archive does not hold ${download.executable}.`));
        }
        // Public programs: any account a Project runs as may read and run them, none may change them.
        yield* integration(() => chmod(join(input.store, folder), 0o755)).pipe(Effect.orElseSucceed(() => undefined));
      }
      commands[runtime.command] = program;
    }
    return commands;
  }));
});

const DIGEST_FOLDER = /^[0-9a-f]{64}$/;
/** An unpack younger than this is never pruned: it may be waiting for the Project state that will name it. */
export const RUNTIME_PRUNE_GRACE_MS = 10 * 60_000;

/**
 * Removes builds no Project names any more. A build is named by a Project's recipe state (the commands it runs from)
 * or by an unfinished upgrade's journal (the commands it left and the ones it is moving to), wherever in the store.
 * Runs under the store's gate, so it never races an acquisition, and spares anything unpacked recently.
 */
export const pruneRuntimeStore = Effect.fn("RecipeRuntimes.prune")(function* (input: {
  readonly store: string;
  readonly projects: string;
  readonly now?: number;
  readonly graceMs?: number;
}) {
  const stored = yield* integration(() => readdir(input.store, { withFileTypes: true })).pipe(Effect.orElseSucceed(() => []));
  const folders = stored.filter((entry) => entry.isDirectory() && DIGEST_FOLDER.test(entry.name)).map((entry) => entry.name);
  if (folders.length === 0) return [] as readonly string[];
  return yield* gateOf(input.store).withPermit(Effect.gen(function* () {
    const named = new Set<string>();
    const note = (commands: Readonly<Record<string, unknown>> | undefined) => {
      for (const path of Object.values(commands ?? {})) {
        if (typeof path !== "string" || !path.startsWith(`${input.store}${sep}`)) continue;
        const folder = path.slice(input.store.length + 1).split(sep)[0];
        if (folder) named.add(folder);
      }
    };
    const projects = yield* integration(() => readdir(input.projects, { withFileTypes: true })).pipe(Effect.orElseSucceed(() => []));
    const read = (file: string) => integration(() => readFile(file, "utf8")).pipe(
      Effect.flatMap((text) => evaluate(() => parseJson(text, isRecord))),
      Effect.orElseSucceed((): Record<string, unknown> | undefined => undefined));
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      const zelavis = join(input.projects, project.name, ".zelavis");
      const state = yield* read(join(zelavis, "recipe-state.json"));
      note(isRecord(state?.commands) ? state.commands : undefined);
      const journal = yield* read(join(zelavis, "upgrade", "journal.json"));
      note(isRecord(journal?.commands) ? journal.commands : undefined);
      note(isRecord(journal?.previousCommands) ? journal.previousCommands : undefined);
    }
    const now = input.now ?? Date.now();
    const removed: string[] = [];
    for (const folder of folders.filter((name) => !named.has(name))) {
      const age = yield* integration(() => stat(join(input.store, folder))).pipe(Effect.map((entry) => now - entry.mtimeMs), Effect.orElseSucceed(() => 0));
      if (age < (input.graceMs ?? RUNTIME_PRUNE_GRACE_MS)) continue;
      yield* integration(() => rm(join(input.store, folder), { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined));
      removed.push(folder);
    }
    return removed as readonly string[];
  }));
});
