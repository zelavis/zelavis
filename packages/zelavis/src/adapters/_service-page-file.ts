import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";

const absent = (error: IntegrationFailure) => {
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR");
};

/** Host filesystem boundary. A missing disk file may be supplied by the configured bundle store. */
export const readServicePageFile = Effect.fn("readServicePageFile")(function*(
  packageDirectory: string | undefined,
  specifier: string | undefined,
  bundle: string,
  file: string,
) {
  let directory = packageDirectory;
  if (directory?.startsWith("file://")) directory = fileURLToPath(directory);
  if (!directory && specifier && /^(file:\/\/|\/|\.)/.test(specifier)) {
    const source = specifier.startsWith("file://") ? fileURLToPath(specifier) : specifier;
    const sourceStat = yield* integration(() => stat(source));
    if (sourceStat.isDirectory()) directory = source;
    else if (sourceStat.isFile()) {
      let current = dirname(resolve(source));
      for (let depth = 0; depth < 64; depth++) {
        const manifest = yield* integration(() => stat(join(current, "package.json"))).pipe(
          Effect.catchIf(absent, () => Effect.void),
        );
        if (manifest?.isFile()) { directory = current; break; }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  if (!directory) return undefined;
  const root = yield* integration(() => realpath(directory));
  const expectedBundle = resolve(root, bundle);
  if (!expectedBundle.startsWith(`${root}${sep}`)) return undefined;
  const bundleRoot = yield* integration(() => realpath(expectedBundle));
  // A bundle cannot alias its package root or a different bundle through a symlink.
  if (bundleRoot !== expectedBundle) return undefined;
  const target = yield* integration(() => realpath(join(bundleRoot, file)));
  if (!target.startsWith(`${bundleRoot}${sep}`)) return undefined;
  const targetStat = yield* integration(() => stat(target));
  if (!targetStat.isFile()) return undefined;
  return yield* integration(() => readFile(target));
}, Effect.catchIf(absent, () => Effect.void));
