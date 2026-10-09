import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Exit, Schema } from "effect";
import { RecipeError, type PlanController, type ProcessPlan, type RecipeManifest } from "../core/recipe/index.js";
import { integration } from "../core/runtime/effect-boundary.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import type { ZelavisProjectRecipeLock, ZelavisProjectRuntimeSnapshot, ZelavisProjectRuntimeUpdate, ZelavisProjectRecord } from "../project.js";
import type { StoredPlan } from "./_recipe-plan-state.js";
import type { RecipePhaseName, RecipePhaseResult } from "./_recipe-phase.js";

/**
 * Upgrading a running Project to a newer recipe without taking it down.
 *
 * The Project keeps serving from the processes it already has. The new recipe is staged beside
 * the old one, its `install` phase refreshes configuration and its `start` phase says what the
 * processes should now be; the plan controller then reconciles the running processes to that plan,
 * which leaves unchanged processes untouched, signals ones that reload, and replaces only the
 * rest. Only then does the new recipe become the Project's (a swap of two directories and of the
 * descriptor), and only then is the choice recorded by the Platform.
 *
 * A transaction, in Effect terms. The whole upgrade runs in one `Scope`. Each step that changes
 * something registers its undo as a finalizer the moment it succeeds, so failure, interruption or
 * a defect anywhere runs the undos in reverse order: configuration files are restored first, then
 * the processes are reconciled back to the previous plan (which re-reads those restored files).
 * Nothing needs a separate rollback path.
 *
 * A crash is covered by a journal written before each step. Whether the new recipe is "in effect"
 * is decided by one physical fact, whether the directory swap completed, which `recover` reads
 * and the Platform then records to match.
 */

const Release = Schema.Struct({ version: Schema.String, digest: Schema.String });
const Journal = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  state: Schema.Literals(["staged", "applying", "switching", "switched"]),
  previous: Release,
  target: Release,
  /** Configuration files copied before the new install phase may rewrite them. */
  snapshots: Schema.Array(Schema.Struct({ path: Schema.String, copy: Schema.optional(Schema.String) })),
});
const JournalJson = Schema.fromJsonString(Journal);
type Journal = typeof Journal.Type;

export interface UpgradeLayout {
  /** The Project's `.zelavis` directory. */
  readonly zelavis: string;
  /** The frozen recipe: `<zelavis>/recipe`. */
  readonly recipe: string;
  /** The Project's descriptor: `<project>/project.json`. */
  readonly descriptor: string;
  /** The saved plan and configuration digests. */
  readonly planState: string;
}

export interface UpgradeKitApi {
  readonly layout: (id: string) => UpgradeLayout;
  /** Where the candidate recipe's package lies on this host, if anywhere. */
  readonly recipeSource: (name: string, version: string) => Effect.Effect<string | undefined, RecipeError>;
  /** The content digest of the Project's frozen recipe as it is on disk now. */
  readonly frozenDigest: (id: string) => Effect.Effect<string, RecipeError>;
  /** Copies a package into `<data>/recipe/package` and returns its content digest. */
  readonly stageArtifact: (source: string, data: string) => Effect.Effect<{ readonly digest: string }, RecipeError>;
  readonly readManifest: (packageDirectory: string) => Effect.Effect<RecipeManifest, RecipeError>;
  /** Runs one phase of a recipe package that may not be the Project's current one. */
  readonly phase: (input: { readonly id: string; readonly name: RecipePhaseName; readonly packageDirectory: string; readonly timeoutMs: number }) => Effect.Effect<RecipePhaseResult, RecipeError>;
  readonly controller: (id: string) => Effect.Effect<PlanController | undefined>;
  readonly storedPlan: (id: string) => Effect.Effect<StoredPlan | undefined, RecipeError>;
  readonly saveStoredPlan: (id: string, plan: StoredPlan) => Effect.Effect<void, RecipeError>;
  /** The Project's descriptor with this recipe lock in it, as `prepare` would write it. */
  readonly writeDescriptor: (id: string, recipe: ZelavisProjectRecipeLock) => Effect.Effect<void, RecipeError>;
  readonly snapshot: (id: string) => Effect.Effect<ZelavisProjectRuntimeSnapshot>;
  /** Records that the app was prepared by the recipe with this digest. */
  readonly markInstalled: (id: string, digest: string) => Effect.Effect<void, RecipeError>;
  readonly log: (id: string, message: string) => Effect.Effect<void>;
}

export class UpgradeKit extends Context.Service<UpgradeKit, UpgradeKitApi>()("zelavis/recipe/UpgradeKit") {}

const PHASE_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

const fail = (message: string) => new RecipeError({ operation: "upgrade", message });
const io = <A>(message: string, run: () => Promise<A>) => integration(run).pipe(Effect.mapError(() => fail(message)));
const missing = (error: { readonly cause: unknown }) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const upgradeDirectory = (layout: UpgradeLayout) => join(layout.zelavis, "upgrade");
const journalFile = (layout: UpgradeLayout) => join(upgradeDirectory(layout), "journal.json");

const readJournal = (layout: UpgradeLayout) =>
  integration(() => readFile(journalFile(layout), "utf8")).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catch((error) => missing(error) ? Effect.succeed(undefined) : Effect.fail(fail("The upgrade journal could not be read."))),
    Effect.flatMap((text) => text === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(JournalJson)(text).pipe(Effect.mapError(() => fail("The upgrade journal is not valid.")))),
  );

const writeJournal = (layout: UpgradeLayout, journal: Journal) =>
  Schema.encodeEffect(JournalJson)(journal).pipe(
    Effect.mapError(() => fail("The upgrade journal could not be encoded.")),
    Effect.flatMap((text) => Effect.gen(function* () {
      const failure = "The upgrade journal could not be written.";
      yield* io(failure, () => mkdir(upgradeDirectory(layout), { recursive: true }));
      yield* io(failure, () => writeFile(`${journalFile(layout)}.tmp`, `${text}\n`, { mode: 0o600 }));
      yield* io(failure, () => rename(`${journalFile(layout)}.tmp`, journalFile(layout)));
    })),
  );

const present = (path: string) => integration(() => access(path)).pipe(Effect.as(true), Effect.orElseSucceed(() => false));
const exists = present;

/** Stage the candidate recipe beside the running one and record that it is staged. */
export const prepareRecipeUpdate = Effect.fn("RecipeUpgrade.prepare")(function* (previous: ZelavisProjectRecord, candidate: ZelavisProjectRecord) {
  const kit = yield* UpgradeKit;
  const layout = kit.layout(previous.id);
  const install = previous.recipe.install;
  if (!install) return yield* Effect.fail(fail("Only a Project made from a recipe with install methods can be upgraded while it runs."));
  const before = yield* kit.frozenDigest(previous.id);
  if (candidate.recipe.version === undefined) return yield* Effect.fail(fail("The new recipe has no exact version."));
  if ((yield* readJournal(layout)) !== undefined) return yield* Effect.fail(fail("An earlier upgrade of this Project is unfinished; it must be recovered first."));

  const source = yield* kit.recipeSource(candidate.recipe.name, candidate.recipe.version);
  if (!source) return yield* Effect.fail(fail(`Recipe ${candidate.recipe.name}@${candidate.recipe.version} is not available on this host.`));
  const stage = join(upgradeDirectory(layout), "stage");
  yield* io("The upgrade area could not be cleared.", () => rm(upgradeDirectory(layout), { recursive: true, force: true }));
  yield* io("The upgrade area could not be created.", () => mkdir(stage, { recursive: true }));
  const { digest } = yield* kit.stageArtifact(source, stage).pipe(
    Effect.tapError(() => io("The staged recipe could not be removed.", () => rm(upgradeDirectory(layout), { recursive: true, force: true })).pipe(Effect.orElseSucceed(() => undefined))),
  );

  // The Project keeps its choice, so the new package must still offer it, as a JavaScript method.
  const manifest = yield* kit.readManifest(join(stage, "recipe", "package"));
  const method = manifest.methods.find((offered) => offered.id === install.method && offered.driver === install.driver);
  if (!method || method.driver !== "js" || !manifest.software.some((offered) => offered.version === install.software)) {
    return yield* Effect.fail(fail(`The new recipe no longer offers the "${install.method}" method with software ${install.software}.`));
  }
  const lock: ZelavisProjectRecipeLock = { ...candidate.recipe, install, artifact: { digest } };
  const execution: ZelavisProjectRuntimeUpdate = {
    mode: "recipe",
    previous: { version: previous.recipe.version, digest: before } satisfies RuntimeRelease,
    target: { version: candidate.recipe.version, digest } satisfies RuntimeRelease,
    recipe: lock,
  };
  yield* writeJournal(layout, { v: 1, id: crypto.randomUUID(), state: "staged", previous: execution.previous, target: execution.target, snapshots: [] });
  return execution;
});

/** Copies each configuration file somewhere safe, so a rewrite can be undone. */
const snapshotConfigurations = (layout: UpgradeLayout, plan: ProcessPlan) =>
  Effect.forEach([...new Set(plan.processes.flatMap((process) => process.config ?? []))], (path, index) =>
    Effect.gen(function* () {
      const copy = join(upgradeDirectory(layout), "configs", String(index));
      const there = yield* present(path);
      if (!there) return { path } as const;
      yield* io("A configuration file could not be saved.", () => mkdir(join(upgradeDirectory(layout), "configs"), { recursive: true }));
      yield* io("A configuration file could not be saved.", () => copyFile(path, copy));
      return { path, copy } as const;
    }));

const restoreConfigurations = (snapshots: Journal["snapshots"]) =>
  Effect.forEach(snapshots, ({ path, copy }) => copy === undefined
    ? io("A new configuration file could not be removed.", () => rm(path, { force: true }))
    : io("A configuration file could not be restored.", () => copyFile(copy, path)), { discard: true });

/** The directory swap, in two renames, each undone by the other direction. */
const swapIn = (layout: UpgradeLayout) => Effect.gen(function* () {
  const previous = join(upgradeDirectory(layout), "previous-recipe");
  const staged = join(upgradeDirectory(layout), "stage", "recipe");
  if (yield* present(staged)) {
    yield* io("The running recipe could not be set aside.", () => rm(previous, { recursive: true, force: true }));
    yield* io("The running recipe could not be set aside.", () => rename(layout.recipe, previous));
    yield* io("The new recipe could not be put in place.", () => rename(staged, layout.recipe));
  }
});
const swapBack = (layout: UpgradeLayout) => Effect.gen(function* () {
  const previous = join(upgradeDirectory(layout), "previous-recipe");
  const staged = join(upgradeDirectory(layout), "stage", "recipe");
  if (yield* present(previous)) {
    // The new one goes back where it was staged and the old one returns.
    if (yield* present(layout.recipe)) yield* io("The new recipe could not be set aside.", () => rename(layout.recipe, staged));
    yield* io("The previous recipe could not be restored.", () => rename(previous, layout.recipe));
  }
});

const discardUpgrade = (layout: UpgradeLayout) => io("The upgrade area could not be removed.", () => rm(upgradeDirectory(layout), { recursive: true, force: true }));

/** Puts a Project's saved plan, descriptor and recipe directory back as the journal says they were. */
const returnToPrevious = Effect.fn("RecipeUpgrade.returnToPrevious")(function* (id: string, journal: Journal) {
  const kit = yield* UpgradeKit;
  const layout = kit.layout(id);
  yield* swapBack(layout);
  const saved = join(upgradeDirectory(layout), "descriptor.previous.json");
  if (yield* exists(saved)) yield* io("The previous descriptor could not be restored.", () => rename(saved, layout.descriptor));
  const plan = join(upgradeDirectory(layout), "plan-state.previous.json");
  if (yield* exists(plan)) yield* io("The previous plan could not be restored.", () => rename(plan, layout.planState));
  yield* restoreConfigurations(journal.snapshots);
});

export const applyRecipeUpdate = Effect.fn("RecipeUpgrade.apply")(function* (
  id: string,
  update: ZelavisProjectRuntimeUpdate,
  commit: (choice: "previous" | "target") => Effect.Effect<void, RecipeError>,
) {
  const kit = yield* UpgradeKit;
  const layout = kit.layout(id);
  const journal = yield* readJournal(layout);
  if (!journal || journal.state !== "staged" || journal.target.digest !== update.target.digest) {
    return yield* Effect.fail(fail("This upgrade was not prepared; stage it again."));
  }
  const controller = yield* kit.controller(id);
  const before = yield* kit.storedPlan(id);
  if (!controller || !before) return yield* Effect.fail(fail("The Project is not running from a saved plan, so it cannot be upgraded in place."));
  const candidate = join(upgradeDirectory(layout), "stage", "recipe", "package");
  const external = update.host === true;

  return yield* Effect.scoped(Effect.gen(function* () {
    yield* kit.log(id, `Upgrading to ${update.target.version} without stopping.`);

    // Undo, registered in the order that makes it run correctly: finalizers run last-in first-out, so
    // the configuration files are restored before the processes are reconciled back to read them.
    yield* Effect.addFinalizer((exit) => Exit.isFailure(exit)
      ? controller.reconcile(before.plan).pipe(
          Effect.tap(() => kit.log(id, "The upgrade did not complete; the Project is back on its previous plan.")),
          Effect.catch((error) => Effect.logError(`Returning ${id} to its previous plan failed: ${error.message}`)),
          Effect.asVoid)
      : Effect.void);

    const snapshots = yield* snapshotConfigurations(layout, before.plan);
    const applying: Journal = { ...journal, state: "applying", snapshots };
    yield* writeJournal(layout, applying);
    yield* Effect.addFinalizer((exit) => Exit.isFailure(exit)
      ? restoreConfigurations(snapshots).pipe(Effect.catch((error) => Effect.logError(`Restoring ${id}'s configuration failed: ${error.message}`)))
      : Effect.void);

    // The new recipe prepares what it needs (configuration, directories) and says what should run.
    yield* kit.phase({ id, name: "install", packageDirectory: candidate, timeoutMs: INSTALL_TIMEOUT_MS });
    const started = yield* kit.phase({ id, name: "start", packageDirectory: candidate, timeoutMs: PHASE_TIMEOUT_MS });
    if (started.phase !== "start") return yield* Effect.fail(fail("The new recipe's start phase returned no process plan."));

    const report = yield* controller.reconcile(started.plan);
    yield* kit.log(id, `Upgrade applied: kept ${report.kept.length}, reloaded ${report.reloaded.length}, replaced ${report.replaced.length}, started ${report.added.length}, stopped ${report.removed.length}.`);
    if (!(yield* controller.running)) return yield* Effect.fail(fail("A process is not running after the upgrade."));

    // From here the new recipe becomes the Project's. It is undone if the Platform cannot record it.
    const committed = Effect.gen(function* () {
      yield* writeJournal(layout, { ...applying, state: "switching" });
      yield* io("The previous plan could not be kept.", () => copyFile(layout.planState, join(upgradeDirectory(layout), "plan-state.previous.json")));
      // With an integration host in the transaction, the host's handover swaps the recipe directory and
      // descriptor itself, as part of the one commit; this side only owns the processes and their plan.
      if (!external) {
        yield* io("The previous descriptor could not be kept.", () => copyFile(layout.descriptor, join(upgradeDirectory(layout), "descriptor.previous.json")));
        yield* swapIn(layout);
        yield* kit.writeDescriptor(id, update.recipe);
      }
      const fingerprints = yield* controller.fingerprints;
      yield* kit.saveStoredPlan(id, { plan: started.plan, configs: Object.fromEntries(fingerprints.map((entry) => [entry.name, entry.config])) });
      yield* writeJournal(layout, { ...applying, state: "switched" });
      yield* commit("target");
    }).pipe(
      Effect.onError(() => returnToPrevious(id, applying).pipe(
        Effect.andThen(writeJournal(layout, applying)),
        Effect.catch((error) => Effect.logError(`Undoing ${id}'s switch failed: ${error.message}`)),
      )),
    );
    yield* Effect.uninterruptible(committed);
    yield* kit.markInstalled(id, update.target.digest).pipe(Effect.catch((error) => Effect.logWarning(`Recording ${id}'s prepared recipe failed: ${error.message}`)));
    yield* discardUpgrade(layout).pipe(Effect.catch((error) => Effect.logWarning(`The finished upgrade's workspace was not removed: ${error.message}`)));
    return yield* kit.snapshot(id);
  }));
});

/**
 * After a crash: which recipe is physically the Project's, with everything made consistent with it.
 * The answer is the Platform's to record, so this settles the disk first and then reports.
 */
export const recoverRecipeUpdate = Effect.fn("RecipeUpgrade.recover")(function* (id: string) {
  const kit = yield* UpgradeKit;
  const layout = kit.layout(id);
  const journal = yield* readJournal(layout);
  if (!journal) return "previous" as const;
  if (journal.state === "switched") {
    yield* discardUpgrade(layout);
    return "target" as const;
  }
  // Not switched, or switched only in part: back to the previous recipe, and its processes back on its plan.
  yield* returnToPrevious(id, journal);
  const [controller, before] = [yield* kit.controller(id), yield* kit.storedPlan(id)];
  if (controller && before) yield* controller.reconcile(before.plan);
  yield* discardUpgrade(layout);
  return "previous" as const;
});

/**
 * Settles a workload update whose commit another authority made: the integration host's handover
 * proved which recipe is the Project's, and the processes, plan and configuration follow it.
 * Idempotent: with nothing journaled the workload is already consistent.
 */
export const settleRecipeUpdate = Effect.fn("RecipeUpgrade.settle")(function* (id: string, selection: "previous" | "target") {
  const kit = yield* UpgradeKit;
  const layout = kit.layout(id);
  const journal = yield* readJournal(layout);
  if (!journal) return;
  if (selection === "target") {
    // The host commits only after this side wrote its plan ("switched"); anything earlier cannot have been committed.
    if (journal.state !== "switched") return yield* Effect.fail(fail("The integration host selected the new recipe before its processes were switched; recover the Project manually."));
    yield* discardUpgrade(layout);
    return;
  }
  yield* returnToPrevious(id, journal);
  const [controller, before] = [yield* kit.controller(id), yield* kit.storedPlan(id)];
  if (controller && before) yield* controller.reconcile(before.plan);
  yield* discardUpgrade(layout);
});

/** Whether an upgrade is waiting to be recovered. */
export const upgradePending = (layout: UpgradeLayout) => readJournal(layout).pipe(Effect.map((journal) => journal !== undefined), Effect.orElseSucceed(() => true));
