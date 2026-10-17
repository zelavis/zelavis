import * as Effect from "effect/Effect";
import type {
  CapacityProvider,
  ZelavisCapacityNode,
  ZelavisCapacityProvisionInput,
} from "zelavis/provider";
import { CapacityError } from "./capacity-error.js";
import {
  CLASS_LABEL,
  MANAGED_LABEL,
  PLATFORM_LABEL,
  USER_LABEL_PREFIX,
  capacityIdentity,
  deployKeyName,
  platformLabelValue,
} from "./capacity-naming.js";
import type { CloudMachine, CloudPort, MachineClass } from "./cloud-port.js";
import {
  createProvisioningState,
  type ConditionalStore,
  type FencedState,
  type SecretCodec,
} from "./provisioning-state.js";

/**
 * `CapacityProvider` over one cloud.
 *
 * Authority: this creates and releases machines and reports what the cloud
 * says. It never decides where a Project runs (Fabric does), and a machine is
 * not a ready Node until the Platform has verified its Agent (`enrollment`),
 * whatever the cloud reports. It deletes only machines carrying this
 * Platform's labels, never an adopted or foreign one.
 *
 * Invariants:
 * - A node's id is the deterministic machine name derived from the request id,
 *   so the same request always means the same machine, and a retry after any
 *   crash adopts instead of duplicating.
 * - `maxNodes` is a hard ceiling here as a last line of defense; the capacity
 *   controller's policy is the primary place caps are decided.
 * - Concurrent identical requests share one run, and a second process taking
 *   over the same node fences the first (see provisioning state).
 */
export interface CapacityProviderOptions {
  readonly platformId: string;
  /** Names this worker as the owner of the provisioning state it acquires. */
  readonly workerId: string;
  readonly cloud: CloudPort;
  readonly store: ConditionalStore;
  readonly secrets: SecretCodec;
  readonly defaults: {
    readonly location: string;
    readonly image: string;
    /** Operator-approved sizes. A request is satisfied by the smallest that fits. */
    readonly machineClasses: readonly MachineClass[];
    readonly maxNodes: number;
    /** Locations a request may name; defaults to just `location`. */
    readonly allowedLocations?: readonly string[];
  };
  readonly enrollment: {
    /** True once the Platform has verified this node's Agent. */
    readonly isEnrolled: (nodeId: string) => boolean | Promise<boolean>;
  };
  /**
   * How long a deploy key may exist with no machine before it is treated as an orphan. A key is created just before
   * its machine, so a younger one may belong to a request still in flight. Defaults to 15 minutes.
   */
  readonly orphanKeyGraceMs?: number;
  /** The clock, for tests. */
  readonly now?: () => number;
  /** First-boot script (for example, the Agent installer). Never contains this process's secrets. */
  readonly userData?: (context: { readonly nodeId: string }) => string | Promise<string>;
}

const STAGE = "capacity";
const MAX_USER_LABELS = 20;
const LABEL_PART = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const RESERVED = new Set([MANAGED_LABEL, PLATFORM_LABEL, "zelavis.io/request", CLASS_LABEL]);
const ENROLLMENT_CONCURRENCY = 4;

const invalid = (message: string) => new CapacityError("invalid-request", message);

function validateUserLabels(labels: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = Object.entries(labels ?? {});
  if (entries.length > MAX_USER_LABELS) throw invalid(`At most ${MAX_USER_LABELS} labels are allowed.`);
  for (const [key, value] of entries) {
    if (!LABEL_PART.test(key) || (value !== "" && !LABEL_PART.test(value))) {
      throw invalid(`Label "${key}" must use letters, digits, '.', '_' or '-' and be at most 63 characters.`);
    }
    if (RESERVED.has(`${USER_LABEL_PREFIX}${key}`)) throw invalid(`Label "${key}" is reserved.`);
    result[`${USER_LABEL_PREFIX}${key}`] = value;
  }
  return result;
}

const userLabelsOf = (labels: Readonly<Record<string, string>>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key.startsWith(USER_LABEL_PREFIX) && !RESERVED.has(key)) result[key.slice(USER_LABEL_PREFIX.length)] = value;
  }
  return result;
};

/** The smallest operator-approved class that satisfies the request. */
function chooseMachineClass(
  classes: readonly MachineClass[],
  resources: ZelavisCapacityProvisionInput["resources"],
): MachineClass {
  const fits = classes
    .filter(
      (candidate) =>
        candidate.cpuCores >= (resources?.cpuCores ?? 0) &&
        candidate.memoryBytes >= (resources?.memoryBytes ?? 0) &&
        candidate.diskBytes >= (resources?.diskBytes ?? 0),
    )
    .sort(
      (a, b) => a.cpuCores - b.cpuCores || a.memoryBytes - b.memoryBytes || a.diskBytes - b.diskBytes,
    );
  const chosen = fits[0];
  if (chosen === undefined) {
    throw new CapacityError("no-machine-class", "No approved machine class satisfies the requested resources.");
  }
  return chosen;
}

/** The provider the Platform sees, plus the sweep an operator or controller may run on demand. */
export interface CloudCapacityProvider extends CapacityProvider {
  /** Remove deploy keys this Platform left behind with no machine. Returns how many were removed. */
  sweepOrphanKeys(): Promise<number>;
}

const DEFAULT_ORPHAN_KEY_GRACE_MS = 15 * 60_000;

export function createCapacityProvider(options: CapacityProviderOptions): CloudCapacityProvider {
  const { platformId, workerId, cloud, store, secrets, defaults, enrollment } = options;
  if (!Number.isSafeInteger(defaults.maxNodes) || defaults.maxNodes < 1) {
    throw new TypeError("maxNodes must be a positive integer.");
  }
  if (defaults.machineClasses.length === 0) throw new TypeError("At least one machine class is required.");
  const platformHash = platformLabelValue(platformId);
  const allowedLocations = defaults.allowedLocations ?? [defaults.location];
  const provisioning = createProvisioningState({ store, secrets });
  const clock = options.now ?? Date.now;
  const orphanGraceMs = options.orphanKeyGraceMs ?? DEFAULT_ORPHAN_KEY_GRACE_MS;

  const acquire = (name: string) =>
    provisioning
      .acquire({ stack: name, stage: STAGE, owner: workerId })
      .pipe(Effect.mapError((error) => new CapacityError("state", `Provisioning state: ${error._tag}`, error)));

  const isOurs = (machine: CloudMachine) =>
    machine.labels[MANAGED_LABEL] === "true" && machine.labels[PLATFORM_LABEL] === platformHash;

  const nodeFrom = (machine: CloudMachine) =>
    Effect.gen(function* () {
      const machineClass = defaults.machineClasses.find((candidate) => candidate.name === machine.labels[CLASS_LABEL]);
      let state: ZelavisCapacityNode["state"];
      if (machine.status === "deleting" || machine.status === "stopping") state = "releasing";
      else if (machine.status === "running") {
        const enrolled = yield* Effect.tryPromise({
          try: () => Promise.resolve(enrollment.isEnrolled(machine.name)),
          catch: (cause) => new CapacityError("state", "Enrollment check failed", cause),
        });
        state = enrolled ? "ready" : "provisioning";
      } else state = "provisioning";
      return {
        id: machine.name,
        provider: cloud.provider,
        state,
        ...(machine.region === undefined ? {} : { region: machine.region }),
        ...(machineClass === undefined
          ? {}
          : {
              resources: {
                cpuCores: machineClass.cpuCores,
                memoryBytes: machineClass.memoryBytes,
                diskBytes: machineClass.diskBytes,
              },
            }),
        labels: userLabelsOf(machine.labels),
        metadata: { cloudId: machine.id, ...(machine.address === undefined ? {} : { address: machine.address }) },
      } satisfies ZelavisCapacityNode;
    });

  /**
   * A deploy key with no machine is left by a crash between the key and the machine, with the provisioning state
   * lost, or by a release that could not remove it. It is removed only when it is this Platform's, is older than the
   * grace period, and no machine this Platform manages would use it.
   */
  const sweepEffect = Effect.gen(function* () {
    const [keys, machines] = yield* Effect.all([cloud.listManagedKeys(platformHash), cloud.listManaged(platformHash)]);
    const live = new Set(machines.map((machine) => deployKeyName(machine.name)));
    const now = clock();
    let removed = 0;
    for (const key of keys) {
      if (live.has(key.name) || key.createdAt === 0 || now - key.createdAt < orphanGraceMs) continue;
      yield* cloud.deleteKey(key);
      removed++;
    }
    return removed;
  });
  /** Housekeeping must never decide whether a request succeeds. */
  const sweepQuietly = sweepEffect.pipe(Effect.catch((error) => Effect.logWarning("Orphan deploy key sweep failed", error).pipe(Effect.as(0))));

  const provisionEffect = (input: ZelavisCapacityProvisionInput) =>
    Effect.gen(function* () {
      if (input.platformId !== platformId) throw invalid("This provider serves a different Platform.");
      const userLabels = validateUserLabels(input.labels);
      const location = input.region ?? defaults.location;
      if (!allowedLocations.includes(location)) throw invalid(`Location "${location}" is not allowed.`);
      const machineClass = chooseMachineClass(defaults.machineClasses, input.resources);
      const identity = capacityIdentity({ requestId: input.requestId, platformId: input.platformId });

      const existing = yield* cloud.find(identity.name);
      if (existing !== undefined && !isOurs(existing)) {
        throw new CapacityError("not-managed", "A machine with this name exists and is not managed by this Platform.");
      }
      if (existing === undefined) {
        const managed = yield* cloud.listManaged(platformHash);
        if (managed.length >= defaults.maxNodes) {
          throw new CapacityError("node-cap-reached", `The ceiling of ${defaults.maxNodes} nodes is reached.`);
        }
      }

      if (existing === undefined) yield* sweepQuietly;
      const userData = options.userData === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => Promise.resolve(options.userData?.({ nodeId: identity.name })),
            catch: (cause) => new CapacityError("invalid-request", "Could not build first-boot data", cause),
          });
      const state: FencedState = yield* acquire(identity.name);
      const machine = yield* cloud.ensureMachine({
        identity: { name: identity.name, labels: { ...identity.labels, [CLASS_LABEL]: machineClass.name, ...userLabels } },
        machineClass,
        image: defaults.image,
        location,
        ...(userData === undefined ? {} : { userData }),
        state,
      });
      return yield* nodeFrom(machine);
    });

  const releaseEffect = (nodeId: string) =>
    Effect.gen(function* () {
      const machine = yield* cloud.find(nodeId);
      if (machine !== undefined && !isOurs(machine)) {
        throw new CapacityError("not-managed", "Refusing to release a machine this Platform did not create.");
      }
      const state = yield* acquire(nodeId);
      yield* cloud.removeMachine({ identity: { name: nodeId, labels: {} }, state });
      // State is the normal route. If the machine is still there, the state was
      // lost; the labels already proved it is ours, so remove it directly.
      const remaining = yield* cloud.find(nodeId);
      if (remaining !== undefined) {
        if (!isOurs(remaining)) throw new CapacityError("not-managed", "Machine changed owner during release.");
        yield* cloud.forceDelete(remaining);
      }
      yield* sweepQuietly;
    });

  const inflight = new Map<string, Promise<ZelavisCapacityNode>>();
  const toPromise = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchDefect((defect) => Effect.fail(defect)),
        Effect.mapError((error) =>
          error instanceof CapacityError ? error : new CapacityError("cloud", String((error as Error)?.message ?? error), error),
        ),
      ),
    );

  return {
    sweepOrphanKeys: () => toPromise(sweepEffect),
    provision(input) {
      let key: string;
      try {
        key = capacityIdentity({ requestId: input.requestId, platformId: input.platformId }).name;
      } catch (error) {
        return Promise.reject(new CapacityError("invalid-request", (error as Error).message));
      }
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const started = toPromise(provisionEffect(input)).finally(() => inflight.delete(key));
      inflight.set(key, started);
      return started;
    },
    release: (nodeId) => toPromise(releaseEffect(nodeId)),
    get: (nodeId) =>
      toPromise(
        Effect.gen(function* () {
          const machine = yield* cloud.find(nodeId);
          return machine === undefined || !isOurs(machine) ? undefined : yield* nodeFrom(machine);
        }),
      ),
    list: () =>
      toPromise(
        Effect.gen(function* () {
          const machines = yield* cloud.listManaged(platformHash);
          return yield* Effect.forEach(machines, nodeFrom, { concurrency: ENROLLMENT_CONCURRENCY });
        }),
      ),
  };
}
