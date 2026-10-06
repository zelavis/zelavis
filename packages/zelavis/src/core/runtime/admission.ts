import { Data, Deferred, Effect } from "effect";

export class RuntimeAdmissionClosed extends Data.TaggedError("RuntimeAdmissionClosed")<{}> {}
export class RuntimeAdmissionFull extends Data.TaggedError("RuntimeAdmissionFull")<{}> {}
export class RuntimeDrainTimeout extends Data.TaggedError("RuntimeDrainTimeout")<{ readonly timeoutMs: number }> {}

/** The stable ingress owns this gate; an engine process never owns its listener. */
export function createRuntimeAdmission(options: { readonly queueLimit: number }) {
  if (!Number.isSafeInteger(options.queueLimit) || options.queueLimit < 1) throw new Error("Admission queue limit must be a positive integer.");
  let paused = false, closed = false, active = 0, waiting = 0;
  let reopened = Deferred.makeUnsafe<void, RuntimeAdmissionClosed>();
  let drained = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(drained, Effect.void);

  const enter: Effect.Effect<() => void, RuntimeAdmissionClosed | RuntimeAdmissionFull> = Effect.gen(function* () {
    if (closed) return yield* new RuntimeAdmissionClosed();
    if (paused) {
      if (waiting >= options.queueLimit) return yield* new RuntimeAdmissionFull();
      waiting++;
      yield* Deferred.await(reopened).pipe(Effect.ensuring(Effect.sync(() => { waiting--; })));
      // A second pause may occur before this fiber resumes. Re-check admission.
      return yield* enter;
    }
    if (active++ === 0) drained = Deferred.makeUnsafe<void>();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--active === 0) Deferred.doneUnsafe(drained, Effect.void);
    };
  });

  return {
    enter,
    pause: Effect.sync(() => {
      if (closed) return;
      if (!paused) { paused = true; reopened = Deferred.makeUnsafe<void, RuntimeAdmissionClosed>(); }
    }),
    resume: Effect.sync(() => {
      if (closed || !paused) return;
      paused = false;
      Deferred.doneUnsafe(reopened, Effect.void);
    }),
    drain: (timeoutMs: number) => Effect.suspend(() => {
      if (!paused) return Effect.die(new Error("Drain requires paused admission."));
      return Deferred.await(drained).pipe(Effect.timeoutOrElse({ duration: timeoutMs,
        orElse: () => Effect.fail(new RuntimeDrainTimeout({ timeoutMs })),
      }));
    }),
    close: Effect.sync(() => {
      closed = true;
      Deferred.doneUnsafe(reopened, Effect.fail(new RuntimeAdmissionClosed()));
    }),
    snapshot: () => ({ paused, closed, active, waiting }),
  };
}

export type RuntimeAdmission = ReturnType<typeof createRuntimeAdmission>;
