import { Effect } from "effect";
import type { IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { engineConvergence } from "../core/runtime/engine-convergence.js";
import { CURRENT_FORMAT } from "../db/kv-store.js";
import { ZELAVIS_VERSION } from "../version.js";
import type { createNodeRuntimeCatalog } from "./_node-runtime-catalog.js";
import { readNodeRuntimeJournalSelection } from "./_node-runtime-journal.js";

/**
 * Which engine a managed app's bound App starts on.
 *
 * It follows the Platform's engine, except across a data-layout change: then it starts on the engine its host last
 * selected, the one that wrote its data, and waits for its own recipe upgrade (`engineConvergence`). A host that has never
 * run has no selection and starts on the Platform's.
 */
export const chooseBoundEngine = Effect.fn("BoundEngine.choose")(function* (input: {
  readonly journalFile: string;
  readonly catalog: ReturnType<typeof createNodeRuntimeCatalog>;
}): Effect.fn.Return<{ readonly version: string; readonly heldReason?: string }, IntegrationFailure> {
  const persisted = yield* readNodeRuntimeJournalSelection(input.journalFile);
  if (persisted === undefined || persisted.version === ZELAVIS_VERSION) return { version: ZELAVIS_VERSION };
  const convergence = engineConvergence({ from: yield* input.catalog.dataFormat(persisted.version), to: CURRENT_FORMAT });
  return convergence.converge ? { version: ZELAVIS_VERSION } : { version: persisted.version, heldReason: convergence.reason };
});
