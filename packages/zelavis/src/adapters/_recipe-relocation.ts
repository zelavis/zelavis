import { chown, lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Effect } from "effect";
import { RecipeError } from "../core/recipe/index.js";
import { integration } from "../core/runtime/effect-boundary.js";

/**
 * Moving an application's data directory to the place a newer recipe names, when its processes are stopped.
 *
 * A running upgrade never moves data (a database directory cannot be renamed under its server): the
 * recipe's processes keep the old location and the Project's layout map remembers it. This runs the next
 * time the Project is started from a stop, and is one atomic rename per directory. There is no journal
 * because the physical state is the journal: a directory is at its old place, at its new place, or (never
 * both with content) in neither, and the layout map is updated only after the rename, so a crash anywhere
 * is finished by the next call.
 */

export interface Relocation {
  readonly name: string;
  /** Where the recipe now wants it, relative to the recipe's root. */
  readonly wanted: string;
}

export interface RelocationResult {
  /** The layout map after this call: names whose directory is now where the recipe wants it. */
  readonly layout: Readonly<Record<string, string>>;
  readonly moved: readonly string[];
  /** Names left at their old place, with the reason. They keep working there and are tried again next time. */
  readonly kept: readonly { readonly name: string; readonly reason: string }[];
}

const fail = (message: string) => new RecipeError({ operation: "start", message });
const kind = (path: string) => integration(() => lstat(path)).pipe(
  Effect.map((stat) => (stat.isDirectory() ? "directory" : "other") as "directory" | "other"),
  Effect.catch((error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? Effect.succeed("absent" as const) : Effect.fail(fail("A data directory could not be inspected."))),
);

export const relocateDirectories = Effect.fn("RecipeRelocation.relocate")(function* (input: {
  readonly root: string;
  readonly layout: Readonly<Record<string, string>>;
  readonly directories: readonly Relocation[];
  readonly owner?: { readonly uid: number; readonly gid: number };
}) {
  const layout: Record<string, string> = { ...input.layout };
  const moved: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const { name, wanted } of input.directories) {
    const current = layout[name] ?? wanted;
    if (current === wanted) { layout[name] = wanted; continue; }
    const from = join(input.root, current), to = join(input.root, wanted);
    if (relative(input.root, to).startsWith("..") || relative(input.root, from).startsWith("..")) {
      kept.push({ name, reason: "a path leaves the Project's directory" });
      continue;
    }
    const [there, here] = [yield* kind(from), yield* kind(to)];
    if (there === "other" || here === "other") { kept.push({ name, reason: "a path is not a directory" }); continue; }
    if (there === "absent") { layout[name] = wanted; if (here === "directory") moved.push(name); continue; }
    if (here === "directory") {
      // Only an empty directory the install made in its place may be replaced; data is never clobbered.
      const entries = yield* integration(() => readdir(to)).pipe(Effect.mapError(() => fail("A data directory could not be inspected.")));
      if (entries.length > 0) { kept.push({ name, reason: `"${wanted}" already holds data` }); continue; }
      yield* integration(() => rmdir(to)).pipe(Effect.mapError(() => fail("An empty directory could not be replaced.")));
    }
    yield* integration(() => mkdir(dirname(to), { recursive: true, mode: 0o700 })).pipe(Effect.mapError(() => fail("A data directory's parent could not be created.")));
    if (input.owner) {
      const { uid, gid } = input.owner;
      // Parents created for the move belong to the Project's account, as the rest of its tree does.
      for (let parent = dirname(to); parent !== input.root && !relative(input.root, parent).startsWith(".."); parent = dirname(parent)) {
        yield* integration(() => chown(parent, uid, gid)).pipe(Effect.mapError(() => fail("A data directory's parent could not be handed to the Project.")));
      }
    }
    yield* integration(() => rename(from, to)).pipe(Effect.mapError(() => fail("A data directory could not be moved.")));
    layout[name] = wanted;
    moved.push(name);
  }
  return { layout, moved, kept } satisfies RelocationResult;
});
