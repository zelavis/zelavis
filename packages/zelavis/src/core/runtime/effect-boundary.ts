import { Data, Deferred, Effect, Exit, Semaphore } from "effect";

/** Structural contract accepted by native orchestration; domain errors retain their specific tags. */
export interface TaggedFailure extends Error { readonly _tag: string; }

/** An external integration failed; retain its original cause for the public Promise boundary. */
export class IntegrationFailure extends Data.TaggedError("IntegrationFailure")<{ readonly cause: unknown; readonly message: string }> {
  constructor(cause: unknown) { super({ cause, message: cause instanceof Error ? cause.message : String(cause) }); }
}

export function unwrapFailure(cause: unknown): unknown {
  return cause instanceof IntegrationFailure ? unwrapFailure(cause.cause) : cause;
}

/** Non-cancellable calls finish before interruption; opt in only when the integration honours cancellation. */
export const integration = <A>(operation: (signal: AbortSignal) => A | PromiseLike<A>, options?: { readonly interruptible?: boolean }): Effect.Effect<A, IntegrationFailure> => {
  const program = Effect.tryPromise({
    try: (signal) => Promise.resolve(operation(signal)),
    catch: (cause) => new IntegrationFailure(cause),
  });
  return options?.interruptible ? program : Effect.uninterruptible(program);
};

/** Expected synchronous validation failures belong in the typed failure channel. */
export const evaluate = <A>(operation: () => A): Effect.Effect<A, IntegrationFailure> => Effect.try({
  try: operation,
  catch: cause => new IntegrationFailure(cause),
});

/** Promise presentation for APIs whose public contract is Promise-based. */
export const present = <A, E>(program: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(program).catch(cause => { throw unwrapFailure(cause); });

export type EffectOperations<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer Args) => infer A
    ? Extract<A, PromiseLike<unknown>> extends never
      ? T[K]
      : (...args: Args) => Effect.Effect<Awaited<A>, TaggedFailure>
    : T[K];
};

type Program = (...args: any[]) => Effect.Effect<any, TaggedFailure>;
const implementations = new WeakMap<object, Record<string, Program>>();

/** Native programs retain interruption; Promise-only protocols finish their call before interruption.
 * Pass pure method names explicitly for an external protocol mixing queries and async operations.
 */
export function effectOperations<T extends object>(owner: T, synchronous: readonly (keyof T)[] = []): EffectOperations<T> {
  return new Proxy(owner, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const programs = implementations.get(owner);
      const program = programs?.[String(key)];
      if (synchronous.includes(key as keyof T) || programs && !program) return value.bind(target);
      return (...args: unknown[]) => program
        ? Effect.suspend(() => program(...args))
        : integration(() => Reflect.apply(value, target, args)).pipe(Effect.uninterruptible);
    },
  }) as EffectOperations<T>;
}

/** Register the Effect implementation behind a Promise-based public protocol. */
type Presentations<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer Args) => Effect.Effect<infer A, any, any>
    ? (...args: Args) => Promise<A>
    : never;
};

export function presentOperations<T extends { [K in keyof T]: Program | undefined }>(programs: T): Presentations<T> {
  const entries = Object.entries(programs).filter((entry): entry is [string, Program] => typeof entry[1] === "function");
  const presentation = Object.fromEntries(entries.map(([name, program]) =>
    [name, (...args: unknown[]) => present(program(...args))]));
  implementations.set(presentation, Object.fromEntries(entries));
  return presentation as unknown as Presentations<T>;
}

/** Concurrent callers share one result; interruption also completes every waiter. */
export function singleFlight<A>(pending: Map<string, Deferred.Deferred<A, TaggedFailure>>, key: string,
  operation: () => Effect.Effect<A, TaggedFailure>, retain = false): Effect.Effect<A, TaggedFailure> {
  return Effect.suspend(() => {
    const existing = pending.get(key);
    if (existing) return Deferred.await(existing);
    const completion = Deferred.makeUnsafe<A, TaggedFailure>();
    pending.set(key, completion);
    return Effect.suspend(operation).pipe(Effect.onExit(exit => Effect.gen(function* () {
      if (!retain || Exit.isFailure(exit)) pending.delete(key);
      yield* Deferred.done(completion, exit);
    })));
  });
}

/** Project transitions share one permit, released on success, failure or interruption. */
export function lifecycleGate() {
  const entries = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  return <A>(id: string, operation: () => Effect.Effect<A, TaggedFailure>): Effect.Effect<A, TaggedFailure> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = entries.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        entries.set(id, entry);
        return entry;
      }),
      entry => entry.semaphore.withPermit(Effect.suspend(operation)),
      entry => Effect.sync(() => { if (--entry.users === 0) entries.delete(id); }),
    );
}
