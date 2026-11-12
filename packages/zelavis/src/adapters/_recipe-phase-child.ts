import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { runPhaseInChild } from "./_recipe-phase.js";

/**
 * Entry point of a recipe phase's own process. The parent (`runRecipePhase`) writes one request
 * to stdin and reads progress and the result from file descriptor 3; this file does nothing else.
 */
Effect.runFork(runPhaseInChild(readFileSync(0, "utf8")).pipe(
  Effect.ensuring(Effect.sync(() => process.exit(0))),
));
