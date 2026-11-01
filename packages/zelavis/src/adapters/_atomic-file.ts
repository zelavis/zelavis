import { chmod, rename, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";

/** Write beside the target, then rename: a reader never sees half a file. */
export const writeFileAtomically = (file: string, content: string, mode: number) =>
  Effect.gen(function* () {
    const temporary = `${file}.${process.pid}.tmp`;
    yield* integration(() => writeFile(temporary, content, { mode }));
    yield* integration(() => chmod(temporary, mode));
    yield* integration(() => rename(temporary, file));
  });
