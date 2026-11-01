import { Effect } from "effect";
import type { IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { engineConvergence } from "../core/runtime/engine-convergence.js";
import { CURRENT_FORMAT } from "../db/kv-store.js";
import { ZELAVIS_VERSION } from "../version.js";
import type { createNodeRuntimeCatalog } from "./_node-runtime-catalog.js";
import { readNodeRuntimeJournalSelection } from "./_node-runtime-journal.js";
import { dataLayoutOnDisk } from "./_node-data-layout.js";

/**
 * Which engine a managed app's bound App starts on.
 *
 * It follows the Platform's engine, except across a data-layout change: then it starts on the engine its host last
 * selected, the one that wrote its data, and waits for its own recipe upgrade (`engineConvergence`). A host that has never
 * run has no selection and starts on the Platform's.
 */
export const chooseBoundEngine = Effect.fn("BoundEngine.choose")(function* (input: {
  readonly journalFile: string;
  /** `<project>/.zelavis/integration`: where the layout record lives. */
  readonly layoutRoot: string;
  readonly catalog: ReturnType<typeof createNodeRuntimeCatalog>;
}): Effect.fn.Return<{ readonly version: string; readonly heldReason?: string }, IntegrationFailure> {
  const persisted = yield* readNodeRuntimeJournalSelection(input.journalFile);
  if (persisted === undefined) return { version: ZELAVIS_VERSION };
  // The layout on disk is what the data was last written as, which a migration changes and an undone one restores;
  // the engine the host last selected only says what to expect when nothing recorded otherwise.
  const layout = yield* dataLayoutOnDisk({ zelavis: input.layoutRoot }, yield* input.catalog.dataFormat(persisted.version));
  const convergence = engineConvergence({ from: layout.format, to: CURRENT_FORMAT });
  if (convergence.converge) return { version: ZELAVIS_VERSION };
  // Held: on the engine recorded with the undone migration, else the one the host selected.
  return { version: layout.engine ?? persisted.version, heldReason: convergence.reason };
});
