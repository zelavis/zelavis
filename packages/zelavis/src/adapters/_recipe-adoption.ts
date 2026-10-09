import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { RecipeError, type RecipeManifest } from "../core/recipe/index.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { objectFields, arrayOf, isString, parseJson } from "../core/json-validation.js";

/**
 * Upgrading a Project to a newer recipe whose layout differs, without touching its data.
 *
 * An application (WordPress, Drupal, a shop) is a folder of files and a database directory. A
 * recipe that lays them out differently from an earlier version of itself does not need them
 * converted, only moved, and a few values carried over (the ports an existing configuration
 * already refers to, the database password, the socket identity). The new recipe describes that
 * mapping in its manifest (`adopt`); this module carries it out.
 *
 * Reliability rests on three properties.
 * - Nothing but renames within the Project's directory, which are atomic and instant whatever
 *   the size of the database; no file is read, rewritten or copied.
 * - A journal is written before the first rename, so an interrupted adoption resumes (each step
 *   is "do it unless it is already done") and a failed one is reverted exactly.
 * - Two phases. `apply` leaves everything needed to go back (the earlier state file is kept);
 *   only `commit` discards it, and only once the new layout is in use. `revert` puts every
 *   folder back and removes what `apply` created, so the earlier recipe finds its Project as it
 *   left it.
 */

export type Adoption = NonNullable<RecipeManifest["adopt"]>[number];

/** Names of the Project's own `.zelavis` entries that an earlier layout can never claim. */
const RESERVED = new Set(["recipe", "recipe-modules", "secrets", "integration", "recipe-state.json", "adoption.json", "engine"]);
const MAX_STATE_BYTES = 256 * 1024;
const JOURNAL = "adoption.json";

interface Journal {
  readonly v: 1;
  readonly state: "applying" | "applied";
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  readonly secrets: readonly string[];
  readonly marks: readonly string[];
  /** Everything to remove at commit, relative to the earlier layout's directory. */
  readonly discard: readonly string[];
  /** Whether the recipe's root did not exist before this adoption, and so is the adoption's to remove on a revert. */
  readonly createdRoot: boolean;
}

const journalRecord = objectFields<Journal>({
  v: (value): value is 1 => value === 1,
  state: (value): value is Journal["state"] => value === "applying" || value === "applied",
  moves: arrayOf(objectFields<Journal["moves"][number]>({ from: isString, to: isString })),
  secrets: arrayOf(isString), marks: arrayOf(isString), discard: arrayOf(isString),
  createdRoot: (value): value is boolean => typeof value === "boolean",
});

export interface AdoptionLocations {
  /** The Project's `.zelavis` directory: where an earlier layout kept its state. */
  readonly zelavis: string;
  /** Where the recipe keeps its files now. */
  readonly root: string;
  readonly secrets: string;
}

/** What the earlier layout recorded that the new one must keep. */
export interface AdoptedValues {
  readonly ports: Readonly<Record<string, number>>;
  readonly socketId?: string;
}

const fail = (message: string) => new RecipeError({ operation: "adopt", message });
const io = <A>(message: string, run: () => Promise<A>) => integration(run).pipe(Effect.mapError(() => fail(message)));
const present = (path: string) => integration(() => lstat(path)).pipe(Effect.map(() => true), Effect.orElseSucceed(() => false));

/** The first earlier layout whose state file is present, if any. */
export const detectAdoption = (adopt: readonly Adoption[] | undefined, locations: AdoptionLocations) =>
  Effect.gen(function* () {
    for (const adoption of adopt ?? []) {
      if (yield* present(join(locations.zelavis, adoption.state))) return adoption;
    }
    return undefined;
  });

export const adoptionPending = (locations: AdoptionLocations) => present(join(locations.zelavis, JOURNAL));

const readJournal = (locations: AdoptionLocations) =>
  integration(() => readFile(join(locations.zelavis, JOURNAL), "utf8")).pipe(
    Effect.flatMap((text) => Effect.try({ try: () => parseJson(text, journalRecord), catch: () => fail("The adoption journal is malformed.") })),
    Effect.mapError((error) => error instanceof RecipeError ? error : fail("The adoption journal could not be read.")),
  );

const writeJournal = (locations: AdoptionLocations, journal: Journal) =>
  Effect.gen(function* () {
    const file = join(locations.zelavis, JOURNAL);
    const temporary = `${file}.tmp`;
    yield* io("The adoption journal could not be written.", () => writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 }));
    yield* io("The adoption journal could not be written.", () => rename(temporary, file));
  });

const portOf = (state: Record<string, unknown>, key: string, name: string) => {
  const value = state[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
    return Effect.fail(fail(`The earlier layout records no usable port for "${name}".`));
  }
  return Effect.succeed(value);
};

const guard = (adoption: Adoption) => Effect.gen(function* () {
  for (const from of [adoption.state, ...Object.keys(adoption.move), ...(adoption.discard ?? [])]) {
    if (RESERVED.has(from.split("/")[0]!)) return yield* Effect.fail(fail(`"${from}" belongs to the Project, not to an earlier layout.`));
  }
});

/**
 * Moves the earlier layout into place and returns the values to carry over. Safe to run again
 * after an interruption; refuses, changing nothing further, when the picture is not one it can
 * reason about (a folder present both where it was and where it goes).
 */
export const applyAdoption = (adoption: Adoption, locations: AdoptionLocations): Effect.Effect<AdoptedValues, RecipeError> =>
  Effect.gen(function* () {
    yield* guard(adoption);
    const stateFile = join(locations.zelavis, adoption.state);
    const stateStats = yield* io("The earlier layout's state file could not be read.", () => lstat(stateFile));
    if (!stateStats.isFile() || stateStats.size > MAX_STATE_BYTES) return yield* Effect.fail(fail("The earlier layout's state file is not a small regular file."));
    const stateText = yield* io("The earlier layout's state file could not be read.", () => readFile(stateFile, "utf8"));
    const state = yield* Effect.try({
      try: () => { const value: unknown = JSON.parse(stateText); if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object"); return value as Record<string, unknown>; },
      catch: () => fail("The earlier layout's state file is not valid JSON."),
    });

    const ports: Record<string, number> = {};
    for (const [name, key] of Object.entries(adoption.ports ?? {})) ports[name] = yield* portOf(state, key, name);
    if (new Set(Object.values(ports)).size !== Object.values(ports).length) return yield* Effect.fail(fail("The earlier layout gives two ports the same number."));

    const secrets: Record<string, string> = {};
    for (const [name, key] of Object.entries(adoption.secrets ?? {})) {
      const value = state[key];
      if (typeof value !== "string" || !/^[\x21-\x7e]{8,512}$/.test(value)) return yield* Effect.fail(fail(`The earlier layout records no usable value for the secret "${name}".`));
      secrets[name] = value;
    }
    let socketId: string | undefined;
    if (adoption.socketId) {
      const value = state[adoption.socketId];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) return yield* Effect.fail(fail("The earlier layout records no usable socket identity."));
      socketId = value;
    }

    // Written before the first rename: from here on, a crash can be resumed or reverted.
    const moves = Object.entries(adoption.move).map(([from, to]) => ({ from, to }));
    // A resumed adoption keeps what its first run recorded; a first run records whether it makes the root.
    const earlier = (yield* adoptionPending(locations)) ? yield* readJournal(locations) : undefined;
    yield* writeJournal(locations, {
      v: 1, state: "applying", moves, secrets: Object.keys(secrets), marks: [...(adoption.marks ?? [])],
      discard: [adoption.state, ...(adoption.discard ?? [])],
      createdRoot: earlier?.createdRoot ?? !(yield* present(locations.root)),
    });

    for (const { from, to } of moves) {
      const source = join(locations.zelavis, from);
      const destination = join(locations.root, to);
      const [hasSource, hasDestination] = [yield* present(source), yield* present(destination)];
      if (hasSource && hasDestination) return yield* Effect.fail(fail(`"${from}" exists both where it was and where it goes ("${to}"); nothing was moved further.`));
      if (!hasSource && !hasDestination) return yield* Effect.fail(fail(`"${from}" is not there; this does not look like the layout it should be.`));
      if (hasSource) {
        const stats = yield* io(`"${from}" could not be inspected.`, () => lstat(source));
        if (stats.isSymbolicLink()) return yield* Effect.fail(fail(`"${from}" is a symbolic link, which is not moved.`));
        yield* io(`"${from}" could not be moved.`, () => mkdir(dirname(destination), { recursive: true }));
        yield* io(`"${from}" could not be moved.`, () => rename(source, destination));
      }
    }

    yield* io("The carried-over secrets could not be written.", () => mkdir(locations.secrets, { recursive: true, mode: 0o700 }));
    for (const [name, value] of Object.entries(secrets)) {
      const file = join(locations.secrets, name);
      const opened = yield* Effect.result(integration(() => open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)));
      if (Result.isFailure(opened)) {
        // Already there is fine when it is the same value: that is a resumed adoption. A different one is never overwritten.
        if ((opened.failure.cause as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return yield* Effect.fail(fail("A carried-over secret could not be written."));
        const existing = yield* io("A carried-over secret could not be read.", () => readFile(file, "utf8"));
        if (existing !== value) return yield* Effect.fail(fail(`A different value is already stored for the secret "${name}"; it was not replaced.`));
        continue;
      }
      const handle = opened.success;
      yield* io("A carried-over secret could not be written.", () => handle.writeFile(value)).pipe(
        Effect.ensuring(io("A carried-over secret could not be written.", () => handle.close()).pipe(Effect.orElseSucceed(() => undefined))),
      );
      yield* io("A carried-over secret could not be written.", () => chmod(file, 0o600));
    }
    for (const mark of adoption.marks ?? []) {
      yield* io("A completion marker could not be written.", () => mkdir(dirname(join(locations.root, mark)), { recursive: true }));
      yield* io("A completion marker could not be written.", () => writeFile(join(locations.root, mark), "adopted\n", { flag: "a" }));
    }
    const journal = yield* readJournal(locations);
    yield* writeJournal(locations, { ...journal, state: "applied" });
    return { ports, ...(socketId ? { socketId } : {}) };
  });

/** Puts every folder back and removes what `applyAdoption` created, so the earlier recipe finds its Project untouched. */
export const revertAdoption = (locations: AdoptionLocations): Effect.Effect<void, RecipeError> =>
  Effect.gen(function* () {
    if (!(yield* adoptionPending(locations))) return;
    const journal = yield* readJournal(locations);
    for (const mark of journal.marks) yield* io("A completion marker could not be removed.", () => rm(join(locations.root, mark), { force: true }));
    for (const name of journal.secrets) yield* io("A carried-over secret could not be removed.", () => rm(join(locations.secrets, name), { force: true }));
    for (const { from, to } of [...journal.moves].reverse()) {
      const source = join(locations.zelavis, from);
      const destination = join(locations.root, to);
      if ((yield* present(destination)) && !(yield* present(source))) {
        yield* io(`"${to}" could not be moved back.`, () => rename(destination, source));
      }
    }
    // Only a root this adoption made is removed; whatever the install phase generated in it goes too.
    if (journal.createdRoot) yield* io("The new layout could not be removed.", () => rm(locations.root, { recursive: true, force: true }));
    yield* io("The adoption journal could not be removed.", () => rm(join(locations.zelavis, JOURNAL), { force: true }));
  });

/** The new layout is in use: the earlier state and generated leftovers are discarded, and the way back closes. */
export const commitAdoption = (locations: AdoptionLocations): Effect.Effect<void, RecipeError> =>
  Effect.gen(function* () {
    if (!(yield* adoptionPending(locations))) return;
    const journal = yield* readJournal(locations);
    if (journal.state !== "applied") return yield* Effect.fail(fail("The adoption was interrupted; it must finish or be reverted before it can be committed."));
    for (const path of journal.discard) yield* io(`"${path}" could not be removed.`, () => rm(join(locations.zelavis, path), { recursive: true, force: true }));
    yield* io("The adoption journal could not be removed.", () => rm(join(locations.zelavis, JOURNAL), { force: true }));
  });

/** For a journal found after a crash: whether the interrupted step was completed. */
export const adoptionState = (locations: AdoptionLocations) =>
  readJournal(locations).pipe(Effect.map((journal) => journal.state));
