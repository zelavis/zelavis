import { integrationValue, unwrapIntegrationResult, presentProtocol } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { isString, optional, objectFields, parseJson } from "../core/json-validation.js";
/**
 * A Project's recipe, materialized into the Project.
 *
 * The recipe lock names an exact version, but a lock that can only be satisfied
 * by whatever the Platform currently has installed stops meaning anything the
 * moment the Platform upgrades. So the package the Project was created with is
 * copied into the Project's own directory and recorded by content digest; the
 * Project runs that artifact, and refuses to start if it no longer matches.
 *
 * This locks the recipe (its manifest, menu and defaults). The runtime engine
 * that hosts it is still the Platform's own code, which is why the Node driver
 * does not advertise independent runtime versions.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  resolveBundledServiceDirectory,
  linkPlatformPackage,
  loadSystemPackage,
  resolveLocalPackageManifest,
} from "./_local-runtime.js";

/** Where a Project keeps its materialized recipe, inside its data root. */
export const RECIPE_ARTIFACT_DIRECTORY = "recipe";
const PACKAGE_DIRECTORY = "package";
/** What of a package ships as its runnable artifact. */
const ARTIFACT_ENTRIES = ["package.json", "dist", "dashboard"] as const;

async function listFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/** Digest of every file's path and bytes, independent of directory order. */
export async function digestArtifactDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = (await listFiles(directory))
    .map((path) => ({ path, name: relative(directory, path).split(sep).join("/") }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const file of files) {
    hash.update(`${file.name}\0`);
    hash.update(await readFile(file.path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Copies the bundled recipe package into the Project and returns its digest.
 *
 * Built beside the current artifact and swapped in only when complete, so a
 * failure part-way (or an upgrade that cannot finish) never leaves a Project
 * without the artifact it was running.
 */
export async function materializeRecipeArtifact(
  sourceDirectory: string,
  dataDirectory: string,
): Promise<{ digest: string }> {
  const destination = join(dataDirectory, RECIPE_ARTIFACT_DIRECTORY);
  const incoming = `${destination}.incoming`;
  const target = join(incoming, PACKAGE_DIRECTORY);
  await rm(incoming, { recursive: true, force: true });
  try {
    await mkdir(target, { recursive: true });
    for (const entry of ARTIFACT_ENTRIES) {
      const from = join(sourceDirectory, entry);
      if (existsSync(from)) {
        await cp(from, join(target, entry), { recursive: true });
      }
    }
    const digest = await digestArtifactDirectory(target);
    await rm(destination, { recursive: true, force: true });
    await rename(incoming, destination);
    return { digest };
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
}

export class RecipeArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeArtifactError";
  }
}

/**
 * Loads the Project's own recipe after proving it is the one that was locked:
 * same content digest, same package name, same version.
 */
export async function loadRecipeArtifact(
  dataDirectory: string,
  lock: { name: string; version: string; digest: string },
) {
  const destination = join(dataDirectory, RECIPE_ARTIFACT_DIRECTORY);
  const target = join(destination, PACKAGE_DIRECTORY);
  if (!existsSync(target)) {
    throw new RecipeArtifactError(
      `Project recipe ${lock.name}@${lock.version} has no materialized artifact at ${target}.`,
    );
  }

  const actual = await digestArtifactDirectory(target);
  if (actual !== lock.digest) {
    throw new RecipeArtifactError(
      `Project recipe ${lock.name}@${lock.version} does not match its locked digest; refusing to run modified code.`,
    );
  }

  const manifest = resolveLocalPackageManifest(target);
  if (!manifest || manifest.name !== lock.name || manifest.version !== lock.version) {
    throw new RecipeArtifactError(
      `Project recipe artifact is ${manifest?.name}@${manifest?.version}, not the locked ${lock.name}@${lock.version}.`,
    );
  }

  // Lets the artifact resolve `zelavis/sdk` against the Platform running it.
  await linkPlatformPackage(destination);
  return { service: await loadSystemPackage(manifest), manifest };
}

/**
 * Freezes the Project's recipe, once.
 *
 * Runs on every start, so it must not undo itself: an artifact already in the
 * Project that verifies against the recorded digest is kept, even after the
 * Platform's own copy has moved on. A new artifact is only taken from the
 * Platform's bundled package when that is exactly the locked version. A lock
 * for a version that is neither frozen nor bundled cannot be prepared: it throws
 * with the reason, so the Project fails there (and can be upgraded) instead of
 * starting and crashing later.
 */
export function ensureRecipeArtifact(
  recipe: { name: string; version: string },
  projectDirectory: string,
  dataDirectory: string,
  /**
   * Where an installed or checked-out recipe package lies. Bundled recipes are
   * found without it; anything installed from the marketplace is not.
   */
  packageDirectory?: (name: string, version?: string) => Promise<string | undefined> | string | undefined,
): Promise<{ digest: string }> { return presentProtocol(Effect.gen(function* () {
  try {
    const existing = parseJson(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(join(projectDirectory, "project.json"), "utf8")))), objectFields<{ recipe?: { version?: string; artifact?: { digest?: string } } }>({recipe: optional(objectFields<{ version?: string; artifact?: { digest?: string } }>({version: optional(isString), artifact: optional(objectFields<{ digest?: string }>({digest: optional(isString)}))}))}));
    const digest = existing.recipe?.artifact?.digest;
    if (
      digest &&
      existing.recipe?.version === recipe.version &&
      (unwrapIntegrationResult(yield* Effect.result(integrationValue(digestArtifactDirectory(
        join(dataDirectory, RECIPE_ARTIFACT_DIRECTORY, PACKAGE_DIRECTORY),
      ).catch(() => undefined))))) === digest
    ) {
      return { digest };
    }
  } catch (cause) {
    // Only absence permits a first freeze. Corruption must not replace a lock.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  // A Project only runs the exact recipe it was locked to. When there is no
  // frozen copy and this Platform cannot supply that exact version, say so
  // now: preparing would otherwise succeed and the runner would then exit
  // with a message that tells the operator to do what just failed.
  // Local sources first (a checkout, an installed package, what this Platform bundles). Only when
  // none has it is the exact locked version asked for by name and version, which may fetch it.
  const bundled =
    ((yield* integrationValue(packageDirectory?.(recipe.name)))) ??
    resolveBundledServiceDirectory(recipe.name) ??
    ((yield* integrationValue(packageDirectory?.(recipe.name, recipe.version))));
  if (!bundled) {
    throw new Error(
      `Project recipe ${recipe.name}@${recipe.version} is not shipped with this Platform and the Project has no frozen copy of it. Upgrade the Project to a recipe this Platform ships, or delete and recreate it.`,
    );
  }
  const manifest = parseJson((yield* integrationValue(readFile(join(bundled, "package.json"), "utf8"))), objectFields<{
    version?: string;
  }>({version: optional(isString)}));
  if (manifest.version !== recipe.version) {
    throw new Error(
      `Project recipe ${recipe.name}@${recipe.version} cannot be prepared: this Platform ships ${manifest.version ?? "another version"} and the Project has no frozen copy of the version it was created with. Upgrade the Project to it, or delete and recreate the Project.`,
    );
  }
  return (yield* integrationValue(materializeRecipeArtifact(bundled, dataDirectory)));
}).pipe(Effect.withSpan("ensureRecipeArtifact"))); }
