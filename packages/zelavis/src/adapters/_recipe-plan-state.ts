import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { parseProcessPlan, RecipeError, type ProcessPlan } from "../core/recipe/index.js";
import { integration } from "../core/runtime/effect-boundary.js";

/**
 * What a Project's running processes were started from, kept on disk.
 *
 * Two facts survive a restart of the Platform and are needed to carry on: the plan the processes
 * were started from (so they can be matched to what an Agent kept running, and so an upgrade that
 * fails can return to it), and the digest of each process's configuration at that time (so a
 * process that reads a file knows whether the file changed since). Neither holds a secret value:
 * the plan carries references.
 */

const PlanState = Schema.Struct({
  v: Schema.Literal(1),
  plan: Schema.Unknown,
  configs: Schema.Record(Schema.String, Schema.String),
});
const PlanStateJson = Schema.fromJsonString(PlanState);

export interface StoredPlan {
  readonly plan: ProcessPlan;
  readonly configs: Readonly<Record<string, string>>;
}

const unreadable = (cause?: unknown) => new RecipeError({
  operation: "start",
  message: `The Project's saved plan is not valid${cause instanceof Error ? `: ${cause.message.slice(0, 300)}` : ""}.`,
});

export const readPlanState = (
  file: string,
  allowed: { readonly commands: readonly string[]; readonly ports: readonly string[]; readonly directories: readonly string[] },
): Effect.Effect<StoredPlan | undefined, RecipeError> =>
  integration(() => readFile(file, "utf8")).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catch((failure) => (failure.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? Effect.succeed(undefined) : Effect.fail(unreadable(new Error(`the file could not be read (${(failure.cause as NodeJS.ErrnoException | undefined)?.code ?? "unknown"})`)))),
    Effect.flatMap((text) => text === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(PlanStateJson)(text).pipe(
      Effect.mapError(unreadable),
      // Revalidated like any plan: a file on disk is not trusted because this code wrote it once.
      Effect.flatMap((state) => Effect.try({ try: () => parseProcessPlan(state.plan, allowed), catch: (cause) => unreadable(cause) }).pipe(
        Effect.map((plan): StoredPlan => ({ plan, configs: state.configs })))),
    )),
  );

export const writePlanState = (file: string, state: StoredPlan): Effect.Effect<void, RecipeError> =>
  Schema.encodeEffect(PlanStateJson)({ v: 1, plan: state.plan, configs: { ...state.configs } }).pipe(
    Effect.mapError(unreadable),
    Effect.flatMap((text) => {
      const temporary = `${file}.tmp`;
      return integration(() => writeFile(temporary, `${text}\n`, { mode: 0o600 })).pipe(
        Effect.andThen(integration(() => rename(temporary, file))),
        Effect.mapError(() => new RecipeError({ operation: "start", message: "The Project's plan could not be saved." })),
      );
    }),
  );

export const clearPlanState = (file: string) =>
  integration(() => rm(file, { force: true })).pipe(Effect.mapError(() => new RecipeError({ operation: "stop", message: "The Project's saved plan could not be removed." })));
