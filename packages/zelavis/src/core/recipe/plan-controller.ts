import { Context, Data, Deferred, Duration, Effect, Exit, Match, PubSub, Ref, Schedule, Semaphore } from "effect";
import type {
  ZelavisAgentAttachedProcess, ZelavisAgentProcess, ZelavisAgentProcessCommand, ZelavisAgentProcessExit,
  ZelavisAgentProcessOutput, ZelavisAgentProcessStartOptions,
} from "../agent/process-command.js";
import type { AgentPlacementIdentity } from "../agent/placement-lease.js";
import { integration } from "../runtime/effect-boundary.js";
import { planSteps, type Fingerprint, type LiveProcess, type Step, type WantedProcess } from "./plan-diff.js";
import { RecipeError, type ProcessPlan, type ProcessUpdate, type RecipeSecret } from "./recipe.js";

/**
 * Runs a recipe's process plan and, later, changes it into another without stopping what does not
 * have to stop.
 *
 * One operation does everything: `reconcile(plan)` makes the running processes match the plan.
 * Starting a Project is a reconcile from nothing, stopping it is a reconcile to an empty plan,
 * and upgrading it to a newer recipe is a reconcile to the new recipe's plan, where processes
 * whose launch and configuration are unchanged are left running, ones whose configuration alone
 * changed are signalled to reload (nginx, PHP-FPM), and only the rest are replaced. Because the
 * table of running processes is updated after every step and is always the truth, a reconcile
 * that fails midway is undone by reconciling to the previous plan: there is no separate rollback
 * path to get wrong.
 *
 * What it relies on, and why it can be trusted:
 * - everything it needs from the machine arrives through the `PlanHost` service, so a test
 *   supplies a fake Agent and a controlled clock and exercises the real logic;
 * - one permit serializes reconciles, so two cannot interleave;
 * - a process is acquired with `acquireUseRelease`: if it does not become ready, or the reconcile
 *   is interrupted, it is stopped before the failure is reported;
 * - readiness is a polling `Schedule` raced against the process exiting and bounded by a
 *   deadline, so a process that dies fails the step at once instead of at the deadline;
 * - secrets exist only in memory, inside a launch; what is kept and compared is a digest.
 */

const START_CONCURRENCY = 4;
const MAX_LOG_LINES = 500;
/** The configuration digest of an adopted process whose configuration nobody recorded. */
export const UNKNOWN_CONFIG = "unknown";

export interface PlanHostApi {
  readonly workloadId: string;
  readonly cwd: string;
  readonly placement?: AgentPlacementIdentity;
  /** Requirement name to absolute executable. */
  readonly commands: Readonly<Record<string, string>>;
  /** Port name to the number allocated for this Project. */
  readonly ports: Readonly<Record<string, number>>;
  /** What every process gets before the plan's own variables. */
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly pollInterval: Duration.Input;
  readonly stopGrace: Duration.Input;
  readonly resolveSecret: (name: string) => Effect.Effect<string, RecipeError>;
  readonly start: (command: ZelavisAgentProcessCommand, options: ZelavisAgentProcessStartOptions) => Effect.Effect<ZelavisAgentProcess, RecipeError>;
  readonly stop: (process: ZelavisAgentProcess, grace: Duration.Input) => Effect.Effect<void, RecipeError>;
  readonly signal: (process: ZelavisAgentProcess, signal: string) => Effect.Effect<void, RecipeError>;
  /** Whether something accepts connections on this loopback port right now. */
  readonly probePort: (port: number) => Effect.Effect<boolean>;
  readonly pathExists: (path: string) => Effect.Effect<boolean>;
  /** SHA-256 of a text, as lowercase hex. The core carries no hashing of its own. */
  readonly digest: (text: string) => Effect.Effect<string>;
  /** Told of every line a process writes, for the Project's log. */
  readonly onOutput?: (process: string, line: ZelavisAgentProcessOutput) => void;
  /** SHA-256 of a file's content, or a fixed marker when it does not exist. */
  readonly digestFile: (path: string) => Effect.Effect<string, RecipeError>;
}

export class PlanHost extends Context.Service<PlanHost, PlanHostApi>()("zelavis/recipe/PlanHost") {}

export type PlanEvent = Data.TaggedEnum<{
  Started: { readonly name: string };
  Reloaded: { readonly name: string; readonly signal: string };
  Stopped: { readonly name: string };
  /** Exited after it was ready, without being asked to. The controller does not restart it. */
  Exited: { readonly name: string; readonly code: number | null; readonly signal: string | null };
}>;
export const PlanEvent = Data.taggedEnum<PlanEvent>();

export interface ReconcileReport {
  readonly kept: readonly string[];
  readonly reloaded: readonly string[];
  readonly replaced: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface LiveFingerprint {
  readonly name: string;
  readonly launch: string;
  readonly config: string;
}

export interface PlanController {
  /** Makes the running processes match `plan`, changing as little as it can. */
  readonly reconcile: (plan: ProcessPlan) => Effect.Effect<ReconcileReport, RecipeError>;
  /** Takes back processes an Agent kept running. Only into an empty controller. */
  readonly adopt: (plan: ProcessPlan, attached: readonly ZelavisAgentAttachedProcess[], configs: Readonly<Record<string, string>>) => Effect.Effect<void, RecipeError>;
  /** Stops everything, dependents first. */
  readonly stop: Effect.Effect<void, RecipeError>;
  readonly names: Effect.Effect<readonly string[]>;
  /** Whether the plan has processes and every one of them is running. */
  readonly running: Effect.Effect<boolean>;
  readonly fingerprints: Effect.Effect<readonly LiveFingerprint[]>;
  readonly logs: Effect.Effect<readonly { readonly process: string; readonly stream: "stdout" | "stderr"; readonly line: string }[]>;
  readonly events: PubSub.PubSub<PlanEvent>;
}

type PlanProcess = ProcessPlan["processes"][number];
type Readiness = { readonly kind: "port"; readonly port: number; readonly timeoutMs: number } | { readonly kind: "path"; readonly path: string; readonly timeoutMs: number };

interface Launch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface Resolved {
  readonly name: string;
  readonly launch: Launch;
  readonly fingerprint: Fingerprint;
  readonly dependsOn: readonly string[];
  readonly readiness: Readiness;
  readonly update: ProcessUpdate;
  /** How many configuration files it declares. With none there is nothing whose change could be missed. */
  readonly configFiles: number;
}

interface Live {
  readonly name: string;
  readonly process: ZelavisAgentProcess;
  readonly fingerprint: Fingerprint;
  readonly dependsOn: readonly string[];
  readonly readiness: Readiness;
  readonly update: ProcessUpdate;
  readonly exited: Deferred.Deferred<ZelavisAgentProcessExit>;
}

const fail = (message: string) => new RecipeError({ operation: "start", message });

/** Why a process that was started does not count as ready. */
class NotReady extends Data.TaggedError("NotReady")<{}> {}

export const makePlanController: Effect.Effect<PlanController, never, PlanHost> = Effect.gen(function* () {
  const host = yield* PlanHost;
  const sha256 = host.digest;
  const table = yield* Ref.make<ReadonlyMap<string, Live>>(new Map());
  const permit = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<PlanEvent>();
  const output: { process: string; stream: "stdout" | "stderr"; line: string }[] = [];

  const reveal = (value: string | RecipeSecret) => typeof value === "string" ? Effect.succeed(value) : host.resolveSecret(value.secret);

  const record = (name: string) => (line: ZelavisAgentProcessOutput) => {
    host.onOutput?.(name, line);
    output.push({ process: name, stream: line.stream, line: line.line });
    if (output.length > MAX_LOG_LINES) output.splice(0, output.length - MAX_LOG_LINES);
  };

  /** A plan process as the Agent will be asked to run it, and as it is told apart from another. */
  const resolve = Effect.fn("PlanController.resolve")(function* (process: PlanProcess) {
    const executable = host.commands[process.command];
    if (executable === undefined) return yield* Effect.fail(fail(`"${process.name}" uses "${process.command}", which this host did not provide.`));
    const args = yield* Effect.forEach(process.args, reveal);
    const env: Record<string, string> = { ...host.baseEnvironment };
    for (const [name, value] of Object.entries(process.env)) env[name] = yield* reveal(value);

    let readiness: Readiness;
    if ("port" in process.readiness) {
      const port = host.ports[process.readiness.port];
      if (port === undefined) return yield* Effect.fail(fail(`"${process.name}" waits on port "${process.readiness.port}", which has no allocation.`));
      readiness = { kind: "port", port, timeoutMs: process.readiness.timeoutMs };
    } else {
      readiness = { kind: "path", path: process.readiness.path, timeoutMs: process.readiness.timeoutMs };
    }

    const launch: Launch = { executable, args, env };
    const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const configs = yield* Effect.forEach([...(process.config ?? [])].sort(), (path) => host.digestFile(path).pipe(Effect.map((digest) => [path, digest] as const)));
    const resolved: Resolved = {
      name: process.name, launch, dependsOn: process.dependsOn, readiness,
      update: process.update ?? { strategy: "restart" },
      configFiles: process.config?.length ?? 0,
      fingerprint: {
        launch: yield* sha256(JSON.stringify({ executable, args, env: sortedEnv, cwd: host.cwd })),
        config: yield* sha256(JSON.stringify(configs)),
      },
    };
    return resolved;
  });

  const resolveAll = (plan: ProcessPlan) => Effect.forEach(plan.processes, resolve);

  const view = (live: ReadonlyMap<string, Live>): readonly LiveProcess[] =>
    [...live.values()].map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint, dependsOn: entry.dependsOn, alive: entry.process.running }));

  const remember = (live: Live) => Ref.update(table, (current) => new Map(current).set(live.name, live));
  const forget = (name: string) => Ref.update(table, (current) => { const next = new Map(current); next.delete(name); return next; });

  /** Waits until the process is ready, fails the moment it exits, and gives up at its deadline. */
  const awaitReady = Effect.fn("PlanController.awaitReady")(function* (live: Live) {
    const probe = live.readiness.kind === "port" ? host.probePort(live.readiness.port) : host.pathExists(live.readiness.path);
    const waitsOn = live.readiness.kind === "port" ? "its port" : "its readiness file";
    const until = Effect.flatMap(probe, (ready) => ready ? Effect.void : Effect.fail(new NotReady()));
    const polling = until.pipe(Effect.retry({ schedule: Schedule.spaced(host.pollInterval) }), Effect.orDie);
    const died = Deferred.await(live.exited).pipe(Effect.flatMap((exit) =>
      Effect.fail(fail(`"${live.name}" exited before it was ready (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}).`))));
    return yield* Effect.raceFirst(polling, died).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(live.readiness.timeoutMs),
        orElse: () => Effect.fail(fail(`"${live.name}" was not ready on ${waitsOn} within ${live.readiness.timeoutMs} ms.`)),
      }),
    );
  });

  const spawn = Effect.fn("PlanController.spawn")(function* (wanted: Resolved) {
    const exited = yield* Deferred.make<ZelavisAgentProcessExit>();
    const note = record(wanted.name);
    let ready = false;
    const child = yield* host.start({
      workloadId: host.workloadId, ...(host.placement ? { placement: host.placement } : {}),
      executable: wanted.launch.executable, args: wanted.launch.args, cwd: host.cwd, env: wanted.launch.env,
    }, {
      onOutput: note,
      onExit: (exit) => {
        Deferred.doneUnsafe(exited, Effect.succeed(exit));
        if (ready && !exit.requested) PubSub.publishUnsafe(events, PlanEvent.Exited({ name: wanted.name, code: exit.code, signal: exit.signal }));
      },
    });
    const live: Live = { name: wanted.name, process: child, fingerprint: wanted.fingerprint, dependsOn: wanted.dependsOn, readiness: wanted.readiness, update: wanted.update, exited };
    return { live, markReady: () => { ready = true; } };
  });

  const stopLive = Effect.fn("PlanController.stopLive")(function* (live: Live) {
    if (live.process.running) yield* host.stop(live.process, host.stopGrace);
    yield* forget(live.name);
    yield* PubSub.publish(events, PlanEvent.Stopped({ name: live.name }));
  });

  /** Starts a process and returns once it is ready; if it never is, it is stopped before the failure is reported. */
  const bringUp = (wanted: Resolved) =>
    Effect.acquireUseRelease(
      spawn(wanted),
      ({ live, markReady }) => Effect.gen(function* () {
        yield* awaitReady(live);
        yield* remember(live);
        markReady();
        yield* PubSub.publish(events, PlanEvent.Started({ name: live.name }));
      }),
      ({ live }, exit) => Exit.isFailure(exit)
        ? host.stop(live.process, host.stopGrace).pipe(Effect.catch((error) => Effect.logError(`"${live.name}" could not be stopped after a failed start: ${error.message}`)))
        : Effect.void,
    );

  const apply = (resolved: ReadonlyMap<string, Resolved>) => (step: Step) =>
    Match.valueTags(step, {
      Keep: () => Effect.succeed("kept" as const),
      Add: ({ name }) => bringUp(resolved.get(name)!).pipe(Effect.as("added" as const)),
      Replace: ({ name }) => Effect.gen(function* () {
        const old = (yield* Ref.get(table)).get(name);
        if (old) yield* stopLive(old);
        yield* bringUp(resolved.get(name)!);
        return "replaced" as const;
      }),
      Reload: ({ name, signal }) => Effect.gen(function* () {
        const current = (yield* Ref.get(table)).get(name)!;
        yield* host.signal(current.process, signal);
        yield* PubSub.publish(events, PlanEvent.Reloaded({ name, signal }));
        // Still serving, and still the same process: a reload that killed it is a failure, not a success.
        yield* awaitReady(current);
        yield* remember({ ...current, fingerprint: resolved.get(name)!.fingerprint });
        return "reloaded" as const;
      }),
      Remove: ({ name }) => Effect.gen(function* () {
        const old = (yield* Ref.get(table)).get(name);
        if (old) yield* stopLive(old);
        return "removed" as const;
      }),
    });

  const reconcile = Effect.fn("PlanController.reconcile")(function* (plan: ProcessPlan) {
    return yield* permit.withPermit(Effect.gen(function* () {
      const resolved = yield* resolveAll(plan);
      const byName = new Map(resolved.map((entry) => [entry.name, entry]));
      const wanted: readonly WantedProcess[] = resolved.map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint, dependsOn: entry.dependsOn, update: entry.update }));
      const groups = planSteps(view(yield* Ref.get(table)), wanted);
      const done: Record<"kept" | "reloaded" | "replaced" | "added" | "removed", string[]> = { kept: [], reloaded: [], replaced: [], added: [], removed: [] };
      for (const group of groups) {
        const outcomes = yield* Effect.forEach(group, (step) => apply(byName)(step).pipe(Effect.map((outcome) => [step.name, outcome] as const)), { concurrency: START_CONCURRENCY });
        for (const [name, outcome] of outcomes) done[outcome].push(name);
      }
      return done as ReconcileReport;
    }));
  });

  const adopt = Effect.fn("PlanController.adopt")(function* (plan: ProcessPlan, attached: readonly ZelavisAgentAttachedProcess[], configs: Readonly<Record<string, string>>) {
    return yield* permit.withPermit(Effect.gen(function* () {
      if ((yield* Ref.get(table)).size > 0) return yield* Effect.fail(fail("Processes can only be adopted into a controller that runs none."));
      const resolved = yield* resolveAll(plan);
      const claimed = new Set<string>();
      for (const entry of attached) {
        const match = resolved.find((candidate) => !claimed.has(candidate.name) && entry.command.executable === candidate.launch.executable &&
          entry.command.cwd === host.cwd && (entry.command.args?.length ?? 0) === candidate.launch.args.length &&
          candidate.launch.args.every((value, index) => entry.command.args?.[index] === value));
        if (!match || entry.process.workloadId !== host.workloadId || !entry.process.listen) {
          return yield* Effect.fail(fail("The Agent returned a process that does not belong to this Project's plan."));
        }
        claimed.add(match.name);
        const exited = yield* Deferred.make<ZelavisAgentProcessExit>();
        const note = record(match.name);
        entry.process.listen(note);
        for (const line of entry.replay) note(line);
        // The Agent's own record of when it ends; reported like any exit after readiness.
        const process = entry.process;
        yield* Effect.forkDetach(integration(() => process.exit).pipe(
          Effect.tap((exit) => Deferred.succeed(exited, exit).pipe(Effect.andThen(exit.requested ? Effect.void : PubSub.publish(events, PlanEvent.Exited({ name: match.name, code: exit.code, signal: exit.signal }))))),
          Effect.catch((error) => Effect.logWarning(`The Agent could not report how "${match.name}" ended: ${String(error)}`)),
        ));
        yield* remember({
          name: match.name, process, dependsOn: match.dependsOn, readiness: match.readiness, update: match.update, exited,
          // What nobody recorded is assumed changed, so a reload or replacement catches it up; a process that
          // declares no configuration files has nothing that could have changed.
          fingerprint: { launch: match.fingerprint.launch, config: match.configFiles === 0 ? match.fingerprint.config : (configs[match.name] ?? UNKNOWN_CONFIG) },
        });
      }
    }));
  });

  const stop = reconcile({ processes: [] }).pipe(Effect.asVoid);

  return {
    reconcile, adopt, stop,
    names: Ref.get(table).pipe(Effect.map((live) => [...live.keys()])),
    running: Ref.get(table).pipe(Effect.map((live) => live.size > 0 && [...live.values()].every((entry) => entry.process.running))),
    fingerprints: Ref.get(table).pipe(Effect.map((live) => [...live.values()].map((entry) => ({ name: entry.name, launch: entry.fingerprint.launch, config: entry.fingerprint.config })))),
    logs: Effect.sync(() => [...output]),
    events,
  } satisfies PlanController;
});
