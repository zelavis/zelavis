import { objectFields, isString } from "../json-validation.js";
import { Cause, Data, Effect, Exit, Semaphore } from "effect";
import type { RuntimeAdmission } from "./admission.js";
import type { TaggedFailure } from "./effect-boundary.js";

/** Exact immutable execution identity, separate from a recipe and from parent authority. */
export interface RuntimeRelease {
  readonly version: string;
  readonly digest: string;
}

export const runtimeReleaseRecord = objectFields<RuntimeRelease>({
  version: (value): value is string => isString(value) && value.length > 0 && value.length <= 100,
  digest: (value): value is string => isString(value) && /^sha256:[a-f0-9]{64}$/.test(value),
});

export interface RuntimeHandoverCheckpoint {
  readonly generation: number;
  readonly phase: "prepared" | "releasing" | "activating" | "committing" | "ready" | "failed";
  readonly previous: RuntimeRelease;
  readonly target: RuntimeRelease;
}

export class RuntimeHandoverFailure extends Data.TaggedError("RuntimeHandoverFailure")<{
  readonly cause: unknown;
  readonly rollbackCause?: unknown;
  readonly message: string;
}> {
  constructor(input: { readonly cause: unknown; readonly rollbackCause?: unknown }) {
    super({ ...input, message: `Runtime handover failed: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}${input.rollbackCause ? "; rollback requires fenced recovery" : ""}` });
  }
}

/** Host methods acknowledge completion, not merely delivery of a process command.
 * prepare must not open live stores or run background work. deactivate must prove
 * the old owner released stores and workloads before activate can grant ownership.
 * discard must prove the candidate has stopped, including after partial activation.
 * A recovery host must fence unfinished generations before constructing a controller.
 */
export interface RuntimeHandoverHost<Candidate, Owner> {
  prepare(release: RuntimeRelease): Effect.Effect<Candidate, TaggedFailure>;
  /** Recheck live workload continuity after admission has drained. */
  qualify?(owner: Owner): Effect.Effect<void, TaggedFailure>;
  deactivate(owner: Owner): Effect.Effect<void, TaggedFailure>;
  activate(candidate: Candidate, generation: number): Effect.Effect<Owner, TaggedFailure>;
  restore(release: RuntimeRelease, generation: number): Effect.Effect<Owner, TaggedFailure>;
  probe(owner: Owner): Effect.Effect<void, TaggedFailure>;
  discard(candidate: Candidate): Effect.Effect<void, TaggedFailure>;
  checkpoint(value: RuntimeHandoverCheckpoint): Effect.Effect<void, TaggedFailure>;
  commit(release: RuntimeRelease, owner: Owner, generation: number): Effect.Effect<void, TaggedFailure>;
}

/** One handover for every role. Role and Fabric authority are engine configuration,
 * never a second update algorithm. Admission stays paused on an unproven rollback.
 */
export function createRuntimeHandover<Candidate, Owner>(options: {
  readonly host: RuntimeHandoverHost<Candidate, Owner>;
  readonly admission: RuntimeAdmission;
  readonly initial: { readonly release: RuntimeRelease; readonly owner: Owner; readonly generation: number };
  readonly drainTimeoutMs: number;
}) {
  const permit = Semaphore.makeUnsafe(1);
  const { host, admission } = options;
  let current = options.initial;
  let generationCounter = current.generation;
  let poisoned = false;
  let recoveryFailure: unknown;
  const replace = Effect.fn("Runtime.handover")(function* (target: RuntimeRelease) {
    if (poisoned) return yield* new RuntimeHandoverFailure({ cause: new Error("Handover requires fenced recovery after failed rollback.") });
    if (target.version === current.release.version && target.digest === current.release.digest) return current;
    const previous = current;
    // Even an aborted drain has persisted a candidate generation. Never reuse
    // it on a later attempt while the previous owner keeps its original epoch.
    const generation = ++generationCounter;
    if (!Number.isSafeInteger(generation + 1)) return yield* new RuntimeHandoverFailure({ cause: new Error("Runtime generation exhausted.") });
    const record = (phase: RuntimeHandoverCheckpoint["phase"], epoch = generation) =>
      host.checkpoint({ generation: epoch, phase, previous: previous.release, target });
    let candidateDisposed = false;
    let released = false;
    return yield* Effect.acquireUseRelease(
      host.prepare(target),
      candidate => Effect.gen(function* () {
        yield* record("prepared").pipe(Effect.onError(cause => Effect.sync(() => {
          poisoned = true; recoveryFailure = Cause.squash(cause);
        })));
        // Before releasing the old owner, interruption and drain timeout are reversible.
        yield* admission.pause;
        return yield* Effect.gen(function* () {
          yield* admission.drain(options.drainTimeoutMs);
          if (host.qualify) yield* host.qualify(previous.owner);
          // Ownership transfer must complete or prove rollback, even if its caller leaves.
          return yield* Effect.uninterruptible(Effect.gen(function* () {
            const transfer = yield* Effect.exit(Effect.gen(function* () {
              yield* record("releasing").pipe(Effect.onError(cause => Effect.sync(() => {
                poisoned = true; recoveryFailure = Cause.squash(cause);
              })));
              // A failed deactivation can have partially released stores. Always restore.
              released = true;
              yield* host.deactivate(previous.owner);
              yield* record("activating");
              const owner = yield* host.activate(candidate, generation);
              yield* host.probe(owner);
              yield* record("committing");
              yield* host.commit(target, owner, generation);
              yield* record("ready");
              current = { release: target, owner, generation };
              return current;
            }));
            if (Exit.isSuccess(transfer)) return transfer.value;
            const rollback = yield* Effect.exit(Effect.gen(function* () {
              // Fence a candidate which may already own the data before restoring.
              yield* host.discard(candidate);
              candidateDisposed = true;
              if (!released) return;
              generationCounter = generation + 1;
              const owner = yield* host.restore(previous.release, generation + 1);
              yield* host.probe(owner);
              yield* host.commit(previous.release, owner, generation + 1);
              current = { release: previous.release, owner, generation: generation + 1 };
              yield* record("failed", generation + 1);
            }));
            if (Exit.isFailure(rollback)) {
              poisoned = true;
              recoveryFailure = Cause.squash(rollback.cause);
              return yield* new RuntimeHandoverFailure({ cause: Cause.squash(transfer.cause), rollbackCause: Cause.squash(rollback.cause) });
            }
            return yield* new RuntimeHandoverFailure({ cause: Cause.squash(transfer.cause) });
          }));
        }).pipe(Effect.ensuring(Effect.suspend(() => !released || !poisoned ? admission.resume : Effect.void)));
      }),
      // The host retains the active candidate on success; its discard is for non-owners.
      candidate => Effect.suspend(() => candidateDisposed || current.release === target ? Effect.void : host.discard(candidate)).pipe(
        Effect.catchCause(cause => Effect.gen(function* () {
          poisoned = true;
          recoveryFailure = Cause.squash(cause);
          // A failed standby cleanup cannot displace an owner which was never
          // released. Block another update while keeping that owner serving.
          if (released) yield* admission.pause;
        })),
      ),
    );
  });
  return {
    replace: (release: RuntimeRelease) => permit.withPermit(replace(release)),
    stop: <A, E>(operation: Effect.Effect<A, E>) => permit.withPermit(operation),
    snapshot: () => ({ ...current, lastGeneration: generationCounter, requiresRecovery: poisoned, recoveryFailure }),
  };
}
