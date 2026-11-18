/**
 * Sweeps: Auth's background cleanup worker.
 *
 * A sweep is a bounded run (at most `SWEEP_BATCH` rows removed) repeated every
 * `everyMs`, sooner when a run filled its batch. Each sweep is one fiber; a
 * failed run is logged by the sweep's name and the loop carries on, so a bad
 * row or a transient store failure never stops cleanup.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { unrefSleep } from "../../db/entities.js";

/** The most rows one run removes. */
export const SWEEP_BATCH = 200;
/** How soon a run that filled its batch runs again. */
export const SWEEP_AGAIN_MS = 1000;

export interface AuthSweep<R> {
  readonly name: string;
  readonly everyMs: number;
  /** One bounded run over `runtime`; answers how many rows it removed. */
  readonly run: (runtime: R) => Effect.Effect<number, unknown>;
}

export const defineSweep = <R>(sweep: AuthSweep<R>): AuthSweep<R> => {
  if (!(sweep.everyMs >= SWEEP_AGAIN_MS)) throw new Error(`Sweep ${sweep.name} must run at most once a second`);
  return sweep;
};

export interface RunningSweeps {
  readonly stop: () => Effect.Effect<void>;
}

const loop = <R>(runtime: R, sweep: AuthSweep<R>) => Effect.gen(function* () {
  for (;;) {
    const removed = yield* sweep.run(runtime).pipe(
      // Interruption is `stop`, never a failure to log and carry on from.
      Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), (cause) => Effect.as(Effect.logWarning(`Auth sweep ${sweep.name} failed; it runs again later.`, cause), 0)),
    );
    yield* unrefSleep(removed >= SWEEP_BATCH ? SWEEP_AGAIN_MS : sweep.everyMs);
  }
});

/** Start one fiber per sweep; `stop` interrupts them all and waits for them to end. */
export const startSweeps = <R>(runtime: R, sweeps: ReadonlyArray<AuthSweep<R>>): Effect.Effect<RunningSweeps> =>
  Effect.gen(function* () {
    const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];
    for (const sweep of sweeps) fibers.push(yield* Effect.forkDetach(loop(runtime, sweep)));
    return { stop: () => Fiber.interruptAll(fibers) };
  });
