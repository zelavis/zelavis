import { Effect, Semaphore, type Scope } from "effect";
import { equalBytes, type KvEngine } from "../kv.js";

type Permit = ReturnType<typeof Semaphore.makeUnsafe>;
const permits = new Map<string, { readonly permit: Permit; references: number }>();

/**
 * Bindings whose native file lock excludes every other process can serialize
 * conditions and batches here. Handles for the same file share a scoped permit.
 * Shared filesystems, raw external writers and remote takeover are unsupported.
 */
export const exclusiveKvEngine = (
  engine: KvEngine,
  identity?: string,
): Effect.Effect<KvEngine, never, Scope.Scope> => Effect.gen(function* () {
  const permit = yield* Effect.acquireRelease(Effect.sync(() => {
    if (identity === undefined) return Semaphore.makeUnsafe(1);
    const entry = permits.get(identity) ?? { permit: Semaphore.makeUnsafe(1), references: 0 };
    entry.references++;
    permits.set(identity, entry);
    return entry.permit;
  }), () => Effect.sync(() => {
    if (identity === undefined) return;
    const entry = permits.get(identity)!;
    if (--entry.references === 0) permits.delete(identity);
  }));
  const exclusive = Semaphore.withPermit(permit);
  return {
    ...engine,
    coordination: "engine",
    write: (writes) => exclusive(engine.write(writes)),
    conditionalWrite: (writes, conditions) => exclusive(Effect.gen(function* () {
      for (const condition of conditions) {
        if (!equalBytes(yield* engine.get(condition.key), condition.value)) return false;
      }
      yield* engine.write(writes);
      return true;
    })),
  };
});
