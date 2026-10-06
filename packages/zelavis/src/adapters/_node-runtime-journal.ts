import { parseJson, objectFields, isPositiveInteger, literal, optional } from "../core/json-validation.js";
import { runtimeReleaseRecord } from "../core/runtime/handover.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Semaphore } from "effect";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { RuntimeHandoverCheckpoint, RuntimeRelease } from "../core/runtime/handover.js";

interface RuntimeJournalState {
  readonly format: "zelavis-runtime/1";
  readonly generation: number;
  readonly selected: RuntimeRelease;
  readonly transition?: RuntimeHandoverCheckpoint;
}
const phases = new Set(["prepared", "releasing", "activating", "committing", "ready", "failed"]);
function release(value: unknown): value is RuntimeRelease {
  if (!value || typeof value !== "object") return false;
  const input = value as RuntimeRelease;
  return typeof input.version === "string" && input.version.length > 0 && input.version.length <= 100 && /^sha256:[a-f0-9]{64}$/.test(input.digest);
}
function parse(source: string): RuntimeJournalState {
  const value = parseJson(source, journalRecord, "Invalid runtime journal; fenced recovery required");
  if (value.format !== "zelavis-runtime/1" || !Number.isSafeInteger(value.generation) || value.generation < 1 || !release(value.selected)) throw new Error("Invalid runtime journal; fenced recovery required.");
  const transition = value.transition;
  if (transition && (!phases.has(transition.phase) || !Number.isSafeInteger(transition.generation) || transition.generation < 1 || transition.generation > value.generation || !release(transition.previous) || !release(transition.target))) throw new Error("Invalid runtime transition; fenced recovery required.");
  return value;
}
const sameRelease = (left: RuntimeRelease, right: RuntimeRelease) => left.version === right.version && left.digest === right.digest;

/** A single supervised role owns this scoped journal. Its kernel write lock
 * prevents another supervisor from executing a concurrent recovery. Renaming a
 * flushed file and flushing its directory persists the selected immutable
 * release and generation together; a PID file is never fencing proof.
 */
export const createNodeRuntimeJournal = Effect.fn("RuntimeJournal.open")(function* (file: string) {
  const directory = dirname(file);
  yield* integration(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* Effect.acquireRelease(evaluate(() => {
    const guard = new DatabaseSync(`${file}.guard.sqlite`);
    try { guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); return guard; }
    catch (cause) { guard.close(); throw cause; }
  }), guard => Effect.sync(() => { guard.close(); }));
  const mutex = Semaphore.makeUnsafe(1);
  let state: RuntimeJournalState | undefined;
  let recovered = false;
  const write = Effect.fn("RuntimeJournal.write")(function* (next: RuntimeJournalState) {
    yield* evaluate(() => parse(JSON.stringify(next)));
    const temporary = `${file}.${randomUUID()}`;
    yield* Effect.gen(function* () {
      yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o600)), handle => Effect.gen(function* () {
        yield* integration(() => handle.writeFile(`${JSON.stringify(next)}\n`, "utf8"));
        yield* integration(() => handle.sync());
      }), handle => integration(() => handle.close()).pipe(Effect.orDie));
      yield* integration(() => rename(temporary, file));
      // Windows does not expose a flushable directory handle through Node.
      if (process.platform !== "win32") yield* Effect.acquireUseRelease(integration(() => open(directory, "r")),
        handle => integration(() => handle.sync()), handle => integration(() => handle.close()).pipe(Effect.orDie));
      state = parse(JSON.stringify(next));
    }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
  });
  const selected = () => {
    if (!state || !recovered) throw new Error("Runtime ownership has not been fenced for this supervisor.");
    return state;
  };
  return {
    /** Must stop every prior engine generation before a recovered owner opens
     * stores. Failure leaves the journal unchanged and grants no generation. */
    recover: (initial: RuntimeRelease, fence: Effect.Effect<void, TaggedFailure>, selection: "persisted" | "authorized-initial" = "persisted") => mutex.withPermit(Effect.gen(function* () {
      if (recovered) return yield* new IntegrationFailure(new Error("Runtime journal was already recovered."));
      yield* evaluate(() => { if (!release(initial)) throw new Error("Invalid initial immutable runtime release."); });
      const source = yield* integration(() => readFile(file, "utf8")).pipe(Effect.catchIf(error => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.void));
      const previous = source ? yield* evaluate(() => parse(source)) : undefined;
      const generation = (previous?.generation ?? 0) + 1;
      yield* evaluate(() => { if (!Number.isSafeInteger(generation)) throw new Error("Runtime generation exhausted."); });
      yield* fence;
      // A fresh Project start may carry the immutable snapshot of its explicit
      // persisted Project lock (for example after a stopped recipe upgrade).
      // Ordinary crash recovery preserves the journal's selected release.
      yield* write({ format: "zelavis-runtime/1", selected: selection === "authorized-initial" ? initial : previous?.selected ?? initial, generation });
      recovered = true;
      return { release: state!.selected, generation };
    })),
    checkpoint: (transition: RuntimeHandoverCheckpoint) => mutex.withPermit(Effect.gen(function* () {
      const current = yield* evaluate(selected);
      const previous = current.transition;
      const beginning = transition.phase === "prepared";
      const sameTransition = previous && sameRelease(previous.previous, transition.previous) && sameRelease(previous.target, transition.target);
      const follows = previous && ({ releasing: "prepared", activating: "releasing", committing: "activating", ready: "committing" } as Record<string, string>)[transition.phase] === previous.phase;
      const allowed = beginning
        ? (!previous || ["prepared", "ready", "failed"].includes(previous.phase)) && transition.generation > current.generation && sameRelease(transition.previous, current.selected)
        : sameTransition && (transition.phase === "failed"
          ? sameRelease(current.selected, transition.previous) && transition.generation === current.generation && transition.generation === previous.generation + 1
          : follows && transition.generation === current.generation && (transition.phase !== "ready" || sameRelease(current.selected, transition.target)));
      if (!allowed) return yield* new IntegrationFailure(new Error("Refusing a stale or out-of-order runtime checkpoint."));
      yield* write({ ...current, generation: transition.generation, transition });
    })),
    commit: (target: RuntimeRelease, generation: number) => mutex.withPermit(Effect.gen(function* () {
      const current = yield* evaluate(selected);
      const transition = current.transition;
      const permitted = transition && (sameRelease(transition.target, target)
        ? transition.phase === "committing" && generation === transition.generation && generation === current.generation
        : sameRelease(transition.previous, target) && ["releasing", "activating", "committing", "ready"].includes(transition.phase) && generation === transition.generation + 1 && generation >= current.generation);
      if (!permitted) return yield* new IntegrationFailure(new Error("Release selection has no current handover authority."));
      yield* write({ ...current, generation, selected: target });
    })),
    snapshot: () => state ? parse(JSON.stringify(state)) : undefined,
  };
});

const journalRecord = objectFields<RuntimeJournalState>({ format: literal("zelavis-runtime/1"), generation: isPositiveInteger,
  selected: runtimeReleaseRecord, transition: optional(objectFields<RuntimeHandoverCheckpoint>({
    generation: isPositiveInteger, phase: literal("prepared", "releasing", "activating", "committing", "ready", "failed"),
    previous: runtimeReleaseRecord, target: runtimeReleaseRecord })) });
