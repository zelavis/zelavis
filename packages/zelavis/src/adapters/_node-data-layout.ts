import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { arrayOf, isSafeInteger, isString, literal, objectFields, optional, parseJson } from "../core/json-validation.js";
import { evaluate, integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";

/**
 * Which data layout a native Project's database directory holds, and the swap that changes it.
 *
 * The locked engine says what a Project's data was written with only until a migration replaces the data under the same lock,
 * so the layout actually on disk is recorded here (`data-layout.json`) by the migration that changed it. Without a record the
 * locked engine's declared format is the answer, which is true of every Project nothing has migrated.
 *
 * A swap moves the old data aside (it is never removed), puts the migrated data in its place and journals each step, so a
 * crash leaves a state `settleDataSwap` can finish or undo from the files alone.
 */
export class DataSwapFailure extends Data.TaggedError("DataSwapFailure")<{ readonly message: string }> {}

export interface DataSwapPaths {
  /** `<project>/.zelavis`: holds `data`, the journal and the layout record. */
  readonly zelavis: string;
}
const names = { data: "data", journal: "data-migration.json", layout: "data-layout.json" } as const;
const path = (paths: DataSwapPaths, name: string) => join(paths.zelavis, name);

const layoutRecord = objectFields<{ readonly format: number; readonly engine?: string | undefined }>({ format: isSafeInteger, engine: optional(isString) });
const journalRecord = objectFields<{ readonly state: "swapping" | "swapped"; readonly from: number; readonly to: number; readonly engine?: string | undefined; readonly retained: string; readonly discarded: ReadonlyArray<string> }>({
  state: literal("swapping", "swapped"), from: isSafeInteger, to: isSafeInteger, engine: optional(isString), retained: isString, discarded: arrayOf(isString),
});

const exists = (target: string) => integration(() => stat(target)).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
const write = (target: string, value: unknown) => integration(() => writeFile(target, `${JSON.stringify(value)}\n`, { mode: 0o600 }));

/** The layout of the data on disk: the recorded one (and the engine that wrote it, when a migration was undone), else the locked engine's own. */
export const dataLayoutOnDisk = Effect.fn("DataLayout.layout")(function* (paths: DataSwapPaths, lockedEngineFormat: number): Effect.fn.Return<{ readonly format: number; readonly engine?: string }, IntegrationFailure> {
  const source = yield* integration(() => readFile(path(paths, names.layout), "utf8")).pipe(Effect.catchIf((error) => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.succeed(undefined)));
  if (source === undefined) return { format: lockedEngineFormat };
  const record = yield* evaluate(() => parseJson(source, layoutRecord, "Data layout record"));
  return { format: record.format, ...(record.engine === undefined ? {} : { engine: record.engine }) };
});

/** The format of the data on disk; see `dataLayoutOnDisk`. */
export const dataFormatOnDisk = Effect.fn("DataLayout.format")(function* (paths: DataSwapPaths, lockedEngineFormat: number): Effect.fn.Return<number, IntegrationFailure> {
  return (yield* dataLayoutOnDisk(paths, lockedEngineFormat)).format;
});

/** Records the layout of a directory that holds no database yet: whatever the engine creates there will be this. */
export const recordDataLayout = Effect.fn("DataLayout.record")(function* (paths: DataSwapPaths, format: number) {
  yield* write(path(paths, names.layout), { format });
});

/**
 * Put migrated shards in place of the Project's data, keeping the old data beside it.
 * `migratedShards` becomes `<data>/primary/shards`; every other entry of the old data directory is carried over by rename of the
 * whole directory first, so nothing but the shards is rebuilt.
 */
export const swapInMigratedData = Effect.fn("DataLayout.swap")(function* (paths: DataSwapPaths, input: { readonly migratedShards: string; readonly from: number; readonly to: number; readonly stamp: string; /** The engine version that wrote the data being replaced. */ readonly engine?: string }): Effect.fn.Return<{ readonly retained: string }, DataSwapFailure | IntegrationFailure> {
  const data = path(paths, names.data), retained = `${names.data}.format-${input.from}-${input.stamp}`;
  if (yield* exists(path(paths, names.journal))) return yield* new DataSwapFailure({ message: "A data migration is already recorded for this Project; it must be settled first." });
  if (yield* exists(path(paths, retained))) return yield* new DataSwapFailure({ message: `${retained} already exists.` });
  const journal = { state: "swapping" as const, from: input.from, to: input.to, ...(input.engine === undefined ? {} : { engine: input.engine }), retained, discarded: [] as string[] };
  yield* write(path(paths, names.journal), journal);
  yield* integration(() => rename(data, path(paths, retained)));
  yield* integration(() => mkdir(join(data, "primary"), { recursive: true, mode: 0o700 }));
  yield* integration(() => rename(input.migratedShards, join(data, "primary", "shards")));
  yield* write(path(paths, names.layout), { format: input.to });
  yield* write(path(paths, names.journal), { ...journal, state: "swapped" });
  return { retained };
});

/** The upgrade that needed the swap was recorded: the old data stays where it was moved, the journal is done. */
export const commitDataSwap = Effect.fn("DataLayout.commit")(function* (paths: DataSwapPaths) {
  yield* integration(() => rm(path(paths, names.journal), { force: true }));
});

/** Undo a swap: the migrated data is set aside (never removed), the old data returns and its layout is recorded again. */
export const undoDataSwap = Effect.fn("DataLayout.undo")(function* (paths: DataSwapPaths, stamp: string): Effect.fn.Return<boolean, DataSwapFailure | IntegrationFailure> {
  const source = yield* integration(() => readFile(path(paths, names.journal), "utf8")).pipe(Effect.catchIf((error) => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.succeed(undefined)));
  if (source === undefined) return false;
  const journal = yield* evaluate(() => parseJson(source, journalRecord, "Data migration journal"));
  const data = path(paths, names.data), retained = path(paths, journal.retained);
  if (!(yield* exists(retained))) return yield* new DataSwapFailure({ message: `The data this migration set aside (${journal.retained}) is missing; it cannot be undone.` });
  if (yield* exists(data)) {
    const discarded = `${names.data}.discarded-${stamp}`;
    yield* integration(() => rename(data, path(paths, discarded)));
  }
  yield* integration(() => rename(retained, data));
  yield* write(path(paths, names.layout), { format: journal.from, ...(journal.engine === undefined ? {} : { engine: journal.engine }) });
  yield* integration(() => rm(path(paths, names.journal), { force: true }));
  return true;
});

/**
 * After a crash: a journal that is still present means the upgrade it belonged to may not have been recorded.
 * `lockedEngineFormat` is the format the Project's recorded engine declares; if it equals the swap's target the upgrade
 * was recorded and the swap is committed, otherwise the swap is undone.
 */
export const settleDataSwap = Effect.fn("DataLayout.settle")(function* (paths: DataSwapPaths, lockedEngineFormat: number, stamp: string): Effect.fn.Return<"none" | "committed" | "undone", DataSwapFailure | IntegrationFailure> {
  const source = yield* integration(() => readFile(path(paths, names.journal), "utf8")).pipe(Effect.catchIf((error) => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.succeed(undefined)));
  if (source === undefined) return "none";
  const journal = yield* evaluate(() => parseJson(source, journalRecord, "Data migration journal"));
  const data = path(paths, names.data);
  if (journal.state === "swapped" && lockedEngineFormat === journal.to) { yield* commitDataSwap(paths); return "committed"; }
  // Interrupted between moving the old data aside and putting the migrated data in place: only the old data exists.
  if (journal.state === "swapping" && !(yield* exists(data)) ) {
    yield* integration(() => rename(path(paths, journal.retained), data));
    yield* write(path(paths, names.layout), { format: journal.from, ...(journal.engine === undefined ? {} : { engine: journal.engine }) });
    yield* commitDataSwap(paths);
    return "undone";
  }
  return (yield* undoDataSwap(paths, stamp)) ? "undone" : "none";
});
