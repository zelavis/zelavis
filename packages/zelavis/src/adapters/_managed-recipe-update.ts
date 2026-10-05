import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { ZelavisProjectValidationError, type ZelavisProjectRecord } from "../project.js";
import { manifestProjectRecipe, validatePluginPackageManifest } from "../service.js";
import { materializeRecipeArtifact, digestArtifactDirectory } from "./_recipe-artifact.js";
import { freezeNodeProjectRelease } from "./_node-project-release.js";

/** Freeze integration code only. The running app, its files and its supervisor
 * are outside this transaction; provisioning is never an integration update.
 */
export const prepareManagedRecipeUpdate = Effect.fn("ManagedRecipe.prepareUpdate")(function* (
  directory: string, previous: ZelavisProjectRecord, candidate: ZelavisProjectRecord, source: string,
) {
  const before = join(directory, ".zelavis", "recipe", "package");
  const manifest = yield* Effect.flatMap(integration(() => readFile(join(source, "package.json"), "utf8")), text => evaluate(() => JSON.parse(text)));
  const oldManifest = yield* Effect.flatMap(integration(() => readFile(join(before, "package.json"), "utf8")), text => evaluate(() => JSON.parse(text)));
  const descriptor = yield* Effect.flatMap(integration(() => readFile(join(directory, "project.json"), "utf8")), text => evaluate(() => JSON.parse(text)));
  // The catalogue advertises versions and host package approval, not the full
  // recipe manifest. The acquired, verified package owns integration metadata.
  const definition = yield* evaluate(() => manifestProjectRecipe(validatePluginPackageManifest(manifest)));
  const next = { ...candidate.recipe, managed: definition?.managed, hostPackages: definition?.hostPackages,
    isolation: definition?.isolation, runtimeKinds: definition?.runtimeKinds ?? ["native"] };
  const actual = yield* integration(() => digestArtifactDirectory(before));
  yield* evaluate(() => {
    if (previous.id !== candidate.id || !previous.recipe.managed || !next.managed || previous.recipe.name !== candidate.recipe.name)
      throw new ZelavisProjectValidationError("Integration update requires the same managed app identity.");
    if (manifest.name !== candidate.recipe.name || manifest.version !== candidate.recipe.version)
      throw new ZelavisProjectValidationError("Integration update source does not match the selected recipe name and version.");
    if (oldManifest.name !== previous.recipe.name || oldManifest.version !== previous.recipe.version)
      throw new ZelavisProjectValidationError("Frozen integration recipe does not match the Platform's previous lock.");
    if (descriptor.id !== previous.id || descriptor.recipe?.name !== previous.recipe.name || descriptor.recipe?.version !== previous.recipe.version)
      throw new ZelavisProjectValidationError("Integration host descriptor does not match the Platform's previous lock.");
    if (actual !== descriptor.recipe?.artifact?.digest)
      throw new ZelavisProjectValidationError("Frozen integration recipe does not match the host descriptor digest.");
    if (previous.recipe.artifact !== undefined && actual !== previous.recipe.artifact.digest)
      throw new ZelavisProjectValidationError("Frozen integration recipe does not match the Platform's previous digest.");
    const runtime = oldManifest.zelavis?.project?.runtime;
    if (typeof runtime !== "string" || runtime !== manifest.zelavis?.project?.runtime ||
      JSON.stringify(previous.recipe.hostPackages ?? []) !== JSON.stringify(next.hostPackages ?? []) ||
      (candidate.recipe.hostPackages !== undefined && JSON.stringify(candidate.recipe.hostPackages) !== JSON.stringify(next.hostPackages)) ||
      JSON.stringify(previous.recipe.isolation ?? null) !== JSON.stringify(next.isolation ?? null) ||
      (candidate.recipe.isolation !== undefined && JSON.stringify(candidate.recipe.isolation) !== JSON.stringify(next.isolation)) ||
      JSON.stringify(previous.recipe.runtimeKinds) !== JSON.stringify(next.runtimeKinds))
      throw new ZelavisProjectValidationError("Integration updates cannot change the app's deployment contract. The existing app keeps running.");
  });
  const selected = yield* freezeNodeProjectRelease(directory, directory, previous.recipe.version);
  const staging = join(directory, ".zelavis", "update-preparation", randomUUID());
  yield* integration(() => mkdir(staging, { recursive: true, mode: 0o700 }));
  return yield* Effect.gen(function* () {
    const artifact = yield* integration(() => materializeRecipeArtifact(source, join(staging, ".zelavis")));
    const recipe = { ...next, artifact };
    yield* integration(() => writeFile(join(staging, "project.json"), JSON.stringify({ ...candidate, recipe, runtime: previous.runtime }), { mode: 0o600 }));
    const target = yield* freezeNodeProjectRelease(directory, staging, recipe.version);
    return { mode: "integration" as const, previous: selected, target, recipe };
  }).pipe(Effect.ensuring(integration(() => rm(staging, { recursive: true, force: true })).pipe(Effect.orDie)));
});
