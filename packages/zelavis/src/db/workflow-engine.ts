// @effect-diagnostics unstableApiUsage:off
// Effect's workflow modules (`Workflow`, `Activity`, `WorkflowEngine`) are tagged `@stability unstable`: they can
// change in a minor release. This file is the one place they are used, behind `DatabaseWorkflowEngine`, so the
// acknowledgement is here and nowhere else, and an upstream break touches only this engine. Effect is pinned to an
// exact version, and `test/db-workflows.test.mjs` holds the engine to its behaviour on every bump.
/**
 * A durable `effect/workflow` engine kept in a Zelavis partition.
 *
 * Effect's workflow model is the saga runner: a `Workflow` is replayed from
 * its start on every run, each `Activity` result is recorded the first time it
 * completes and returned from the record on every replay after, and
 * `Workflow.withCompensation` registers the undo of a step to run if the
 * workflow fails after it. What makes it durable is the engine, and this one
 * records in a partition of the database, through its own transactions:
 *
 * - an execution (workflow, id, encoded payload, parent) when it starts, and
 *   its encoded result when it completes;
 * - each activity's encoded result, by execution, activity and attempt, so a
 *   step that completed is never run again, after a crash included;
 * - each durable deferred's encoded exit, and each durable clock's wake time.
 *
 * When a workflow is registered, every execution of it recorded and not
 * complete is resumed, and every clock it was waiting on is scheduled again
 * (at once when its time has passed). Activities are at least once: one cut
 * off before its result was recorded runs again, so an activity's effect must
 * be idempotent — `tenantWriteActivity` gives a Tenant write an idempotency
 * key derived from the execution, so its write lands exactly once.
 *
 * Running executions are in-process, like the database's writer: one
 * process runs a partition's workflows. The control flow follows Effect's own
 * `WorkflowEngine.layerMemory`; persistence is what this adds.
 */
import { Cause, Duration, Effect, Exit, Fiber, FiberMap, Layer, Option, Schedule, Schema, Scope, Stream } from "effect";
import type { OutboxApi, OutboxMessage } from "./outbox.js";
import { Activity, DurableClock, Workflow, WorkflowEngine } from "effect/workflow";
import { isNonNegativeInteger, isString, objectFields, optional, parseJson } from "../core/json-validation.js";
import { equals } from "./query.js";
import type { ObjectStoreApi } from "./store.js";

const NS = {
  execution: "zv.workflow.execution",
  activity: "zv.workflow.activity",
  deferred: "zv.workflow.deferred",
  clock: "zv.workflow.clock",
} as const;
/** Lists a namespace's records, so recovery reads only them. */
const LISTED = "zv.workflow.listed";
/** An encoded payload, result or exit larger than this is a defect, not a record. */
const MAX_RECORD_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ExecutionRecord {
  readonly workflow: string;
  readonly executionId: string;
  readonly payload: unknown;
  readonly parent?: string;
  /** The encoded `Workflow.Result`, once complete. */
  readonly result?: unknown;
}
interface ClockRecord { readonly workflow: string; readonly executionId: string; readonly name: string; readonly deferredName: string; readonly wakeAt: number }

/** Encoded values are checked by their own schemas when decoded; the record only carries them. */
const anyValue = (_value: unknown): _value is unknown => true;
const executionRecord = objectFields<ExecutionRecord>({
  workflow: isString, executionId: isString, payload: anyValue, parent: optional(isString), result: anyValue,
});
const clockRecord = objectFields<ClockRecord>({
  workflow: isString, executionId: isString, name: isString, deferredName: isString, wakeAt: isNonNegativeInteger,
});
const anyRecord = (_value: unknown): _value is unknown => true;

/** How a result and an exit become JSON and back: the success and error are already encoded by their own schemas. */
const ResultJson = Schema.toCodecJson(Workflow.Result({ success: Schema.Any, error: Schema.Any }));
const ExitJson = Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()));

/** Records of one kind, by key, in the partition's own transactions. */
const recordsIn = (store: ObjectStoreApi) => {
  const get = <A>(namespace: string, key: string, check: (value: unknown) => value is A) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(namespace, key);
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      return object === undefined ? undefined : parseJson(decoder.decode(object.bytes), check, namespace);
    }).pipe(Effect.orDie);
  const put = (namespace: string, key: string, value: unknown) =>
    Effect.gen(function* () {
      const bytes = encoder.encode(JSON.stringify(value));
      if (bytes.length > MAX_RECORD_BYTES) return yield* Effect.die(new RangeError(`a workflow record is at most 1 MiB; ${namespace} "${key}" is ${bytes.length} bytes`));
      const seq = (yield* store.lookup(namespace, key)) ?? (yield* store.nextSeq);
      yield* store.transact((txn) => txn.put(seq, bytes, { terms: [], columns: [[LISTED, namespace]], measures: [], edges: [] }, { namespace, key }));
    }).pipe(Effect.orDie);
  const remove = (namespace: string, key: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(namespace, key);
      if (seq !== undefined) yield* store.transact((txn) => txn.retract(seq));
    }).pipe(Effect.orDie);
  const list = <A>(namespace: string, check: (value: unknown) => value is A) =>
    Effect.gen(function* () {
      const found: A[] = [];
      for (const seq of yield* Stream.runCollect(store.resolve(equals(LISTED, namespace)))) {
        const object = yield* store.read(seq);
        if (object !== undefined) found.push(parseJson(decoder.decode(object.bytes), check, namespace));
      }
      return found;
    }).pipe(Effect.orDie);
  return { get, put, remove, list };
};

type Execute = (payload: object, executionId: string) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>;

/** One recorded workflow execution, as an operator sees it. */
export interface WorkflowExecutionSummary {
  readonly workflow: string;
  readonly executionId: string;
  readonly parent?: string;
  /** Finished, with its result recorded; otherwise running, waiting, or left by a restart until its workflow registers. */
  readonly complete: boolean;
  /** Activities whose results are recorded. */
  readonly activities: number;
}

/** Every recorded execution in `store`, oldest workflow name first; at most `limit` (1 to 1000, default 100). */
export const workflowExecutions = (store: ObjectStoreApi, limit = 100) =>
  Effect.gen(function* () {
    const records = recordsIn(store);
    const executions = yield* records.list(NS.execution, executionRecord);
    const activities = new Map<string, number>();
    for (const seq of yield* Stream.runCollect(store.resolve(equals(LISTED, NS.activity))).pipe(Effect.orDie)) {
      const identity = yield* Effect.map(store.scanRecords({ after: (seq - 1) as never, limit: 1 }), ([found]) => found?.record.live === true ? found.record.identity : undefined).pipe(Effect.orDie);
      const executionId = identity?.key.split("/")[0];
      if (executionId !== undefined) activities.set(executionId, (activities.get(executionId) ?? 0) + 1);
    }
    return executions
      .map((held): WorkflowExecutionSummary => ({
        workflow: held.workflow, executionId: held.executionId, ...(held.parent === undefined ? {} : { parent: held.parent }),
        complete: held.result !== undefined, activities: activities.get(held.executionId) ?? 0,
      }))
      .sort((a, b) => (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : a.executionId < b.executionId ? -1 : 1))
      .slice(0, Math.max(1, Math.min(1000, limit)));
  });

/** The engine as a layer: what `DatabaseApi.workflowEngine` is. */
export type DatabaseWorkflowEngine = Layer.Layer<WorkflowEngine.WorkflowEngine>;

/** The engine over `store`, a partition the database keeps for workflows. */
export const databaseWorkflowEngine = (store: ObjectStoreApi): DatabaseWorkflowEngine =>
  Layer.effect(WorkflowEngine.WorkflowEngine)(Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const records = recordsIn(store);
    const workflows = new Map<string, { readonly workflow: Workflow.Any; readonly execute: Execute; readonly scope: Scope.Scope }>();

    interface ExecutionState {
      readonly payload: object;
      readonly execute: Execute;
      readonly parent: string | undefined;
      instance: WorkflowEngine.WorkflowInstance["Service"];
      interrupted: boolean;
      resumeRequested: boolean;
      fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined;
    }
    const executions = new Map<string, ExecutionState>();
    const activities = new Map<string, { exit: Exit.Exit<Workflow.Result<unknown, unknown>> | undefined }>();
    const deferredState = WorkflowEngine.makeDeferredState();
    const clocks = yield* FiberMap.make<string>();

    const recordResult = (executionId: string, result: Workflow.Result<unknown, unknown>) =>
      result._tag !== "Complete" ? Effect.void : Effect.gen(function* () {
        const held = yield* records.get(NS.execution, executionId, executionRecord);
        if (held === undefined) return;
        const encoded = yield* Schema.encodeEffect(ResultJson)(result).pipe(Effect.orDie);
        yield* records.put(NS.execution, executionId, { ...held, result: encoded });
      });

    const resume = Effect.fnUntraced(function* (executionId: string): Effect.fn.Return<void> {
      const state = executions.get(executionId);
      if (!state) return;
      const exit = state.fiber?.pollUnsafe();
      if (exit && exit._tag === "Success" && exit.value._tag === "Complete") return;
      if (state.fiber && !exit) {
        if (!state.resumeRequested) {
          state.resumeRequested = true;
          yield* Fiber.await(state.fiber).pipe(
            Effect.flatMap(() => { state.resumeRequested = false; return resume(executionId); }),
            Effect.forkIn(scope),
          );
        }
        return;
      }
      const entry = workflows.get(state.instance.workflow._tag)!;
      const instance = WorkflowEngine.WorkflowInstance.initial(state.instance.workflow, state.instance.executionId, state.instance.scope);
      state.instance = instance;
      state.fiber = yield* state.execute(state.payload, state.instance.executionId).pipe(
        Effect.onExit(() => {
          if (!state.interrupted) return Effect.void;
          instance.interrupted = true;
          instance.suspended = false;
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)));
        }),
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        (effect) => deferredState.trackRun(instance, effect),
        Effect.tap((result) => recordResult(executionId, result)),
        Effect.tap((result) => !state.parent || result._tag !== "Complete" ? Effect.void : Effect.forkIn(resume(state.parent), scope)),
        Effect.forkIn(entry.scope),
      );
    });

    /** Start (or adopt) an execution of a registered workflow, recorded before it runs. */
    const start = (workflow: Workflow.Any, executionId: string, payload: object, parent: string | undefined) =>
      Effect.gen(function* () {
        const entry = workflows.get(workflow._tag)!;
        let state = executions.get(executionId);
        if (state) return state;
        const held = yield* records.get(NS.execution, executionId, executionRecord);
        if (held === undefined) yield* records.put(NS.execution, executionId, { workflow: workflow._tag, executionId, payload, ...(parent === undefined ? {} : { parent }) });
        state = {
          payload, execute: entry.execute, parent,
          instance: WorkflowEngine.WorkflowInstance.initial(workflow, executionId),
          interrupted: false, resumeRequested: false, fiber: undefined,
        };
        executions.set(executionId, state);
        if (held?.result !== undefined) {
          // Complete before this process started: answered from the record, never run again.
          const result = yield* Schema.decodeUnknownEffect(ResultJson)(held.result).pipe(Effect.orDie);
          state.fiber = yield* Effect.forkIn(Effect.succeed(result), scope);
          return state;
        }
        yield* resume(executionId);
        return state;
      });

    const scheduleWake = (clock: ClockRecord) =>
      Effect.flatMap(Effect.sync(() => Math.max(0, clock.wakeAt - Date.now())), (delay) =>
        engine.deferredDone(DurableClock.make({ name: clock.name, duration: 0 }).deferred, {
          workflowName: clock.workflow, executionId: clock.executionId, deferredName: clock.deferredName, exit: Exit.void,
        }).pipe(
          Effect.andThen(records.remove(NS.clock, `${clock.executionId}/${clock.name}`)),
          Effect.delay(delay),
          FiberMap.run(clocks, `${clock.executionId}/${clock.name}`, { onlyIfMissing: true }),
          Effect.asVoid,
        ));

    const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
      register: Effect.fnUntraced(function* (workflow, execute) {
        workflows.set(workflow._tag, { workflow, execute, scope: yield* Effect.scope });
        // What this workflow left unfinished — a crash, a restart — carries on now it can run again.
        for (const held of yield* records.list(NS.execution, executionRecord)) {
          if (held.workflow !== workflow._tag || held.result !== undefined || executions.has(held.executionId)) continue;
          yield* start(workflow, held.executionId, held.payload as object, held.parent);
        }
        for (const clock of yield* records.list(NS.clock, clockRecord)) {
          if (clock.workflow === workflow._tag) yield* scheduleWake(clock);
        }
      }),
      execute: Effect.fnUntraced(function* (workflow, options) {
        if (!workflows.has(workflow._tag)) return yield* Effect.die(`Workflow ${workflow._tag} is not registered`);
        const state = yield* start(workflow, options.executionId, options.payload, options.parent?.executionId);
        if (options.discard) return undefined as never;
        const instance = state.instance;
        const exit = yield* Fiber.await(state.fiber!);
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) && instance.suspended) return new Workflow.Suspended({}) as never;
        return (yield* exit) as never;
      }),
      interrupt: Effect.fnUntraced(function* (_workflow, executionId) {
        const state = executions.get(executionId);
        if (!state) return;
        state.interrupted = true;
        yield* resume(executionId);
      }),
      interruptUnsafe: Effect.fnUntraced(function* (_workflow, executionId) {
        const state = executions.get(executionId);
        if (!state) return;
        state.interrupted = true;
        if (state.fiber) yield* Fiber.interrupt(state.fiber);
      }),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: Effect.fnUntraced(function* (activity, attempt) {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const activityId = `${instance.executionId}/${activity.name}/${attempt}`;
        const recorded = yield* records.get(NS.activity, activityId, anyRecord);
        if (recorded !== undefined) return yield* Schema.decodeUnknownEffect(ResultJson)(recorded).pipe(Effect.orDie);
        let state = activities.get(activityId);
        if (state) {
          const exit = state.exit;
          if (exit && exit._tag === "Success" && exit.value._tag === "Suspended") state.exit = undefined;
          else if (exit) return yield* exit;
        } else {
          state = { exit: undefined };
          activities.set(activityId, state);
        }
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(instance.workflow, instance.executionId);
        activityInstance.interrupted = instance.interrupted;
        const held = state;
        return yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
          // A completed step is recorded before its result is used, so a replay never runs it again.
          Effect.tap((result) => result._tag !== "Complete" ? Effect.void
            : Effect.flatMap(Schema.encodeEffect(ResultJson)(result).pipe(Effect.orDie), (encoded) => records.put(NS.activity, activityId, encoded))),
          Effect.onExit((exit) => Effect.sync(() => { held.exit = exit; })),
        );
      }),
      poll: (workflow, executionId) =>
        Effect.gen(function* () {
          const state = executions.get(executionId);
          const exit = state?.fiber?.pollUnsafe();
          if (exit) return exit._tag === "Success" ? Option.some(exit.value) : yield* Effect.die(exit.cause);
          const held = yield* records.get(NS.execution, executionId, executionRecord);
          if (held?.workflow !== workflow._tag || held.result === undefined) return Option.none();
          return Option.some(yield* Schema.decodeUnknownEffect(ResultJson)(held.result).pipe(Effect.orDie));
        }),
      deferredResult: Effect.fnUntraced(function* (deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const recorded = yield* records.get(NS.deferred, `${instance.executionId}/${deferred.name}`, anyRecord);
        if (recorded === undefined) return Option.none();
        return Option.some(yield* Schema.decodeUnknownEffect(ExitJson)(recorded).pipe(Effect.orDie));
      }),
      deferredDone: (options) =>
        Effect.gen(function* () {
          const id = `${options.executionId}/${options.deferredName}`;
          if ((yield* records.get(NS.deferred, id, anyRecord)) !== undefined) return;
          yield* records.put(NS.deferred, id, yield* Schema.encodeEffect(ExitJson)(options.exit).pipe(Effect.orDie));
          const wake = Effect.andThen(deferredState.deferredDone(options.executionId, options.deferredName), resume(options.executionId));
          const instance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
          yield* Option.isSome(instance) && instance.value.executionId === options.executionId
            ? wake.pipe(Effect.forkIn(scope), Effect.asVoid)
            : wake;
        }),
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          const key = `${options.executionId}/${options.clock.name}`;
          const held = yield* records.get(NS.clock, key, clockRecord);
          const clock: ClockRecord = held ?? {
            workflow: workflow._tag, executionId: options.executionId, name: options.clock.name,
            deferredName: options.clock.deferred.name, wakeAt: Date.now() + Duration.toMillis(options.clock.duration),
          };
          if (held === undefined) yield* records.put(NS.clock, key, clock);
          yield* scheduleWake(clock);
        }),
    });
    return engine;
  }));

/**
 * An activity that writes to one Tenant exactly once: `write` is handed an idempotency key made of the execution and
 * the activity's name, so a step run again after a crash finds its own receipt instead of writing twice.
 */
export const tenantWriteActivity = <Success extends Schema.Constraint, R>(options: {
  readonly name: string;
  readonly success: Success;
  readonly write: (idempotencyKey: string) => Effect.Effect<Success["Type"], unknown, R>;
}) =>
  Activity.make({
    name: options.name,
    success: options.success,
    error: Schema.Defect(),
    execute: Effect.flatMap(Effect.service(WorkflowEngine.WorkflowInstance), (instance) =>
      options.write(`workflow:${instance.executionId}:${options.name}`)),
  });

/**
 * Start a workflow for every message a Tenant's outbox holds on `topic`, and remove the message once its
 * execution is recorded: the step that turns a committed write into a saga. Delivery is at least once, and an
 * execution's id comes from the workflow's own `idempotencyKey` over the payload, which `payloadOf` should take
 * from the message id, so a message delivered twice starts one execution. Runs until interrupted, a page every
 * `interval` once the outbox is drained; needs the engine (`databaseWorkflowEngine`) in context.
 */
export const startFromOutbox = <Payload extends Workflow.AnyStructSchema>(options: {
  readonly outbox: OutboxApi;
  readonly topic: string;
  readonly workflow: Workflow.Workflow<string, Payload, Schema.Top, Schema.Top>;
  readonly payloadOf: (message: OutboxMessage) => Payload["Type"];
  readonly interval: Duration.Input;
}) =>
  Effect.gen(function* () {
    const page = yield* options.outbox.read({ topic: options.topic, limit: 100 });
    for (const message of page.messages) {
      yield* options.workflow.execute(options.payloadOf(message), { discard: true });
      yield* options.outbox.remove({ ids: [message.id] }).pipe(Effect.orDie);
    }
    return page.messages.length;
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced(options.interval), while: () => true }),
    Effect.asVoid,
  );
