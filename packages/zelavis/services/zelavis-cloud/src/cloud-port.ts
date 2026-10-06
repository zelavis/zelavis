import type * as Effect from "effect/Effect";
import type { CapacityIdentity } from "./capacity-naming.js";
import type { CapacityError } from "./capacity-error.js";
import type { FencedState } from "./provisioning-state.js";

/** A machine size an operator allows, named as the cloud names it. */
export interface MachineClass {
  readonly name: string;
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

/** What the cloud reports about a machine, independent of any provisioning state. */
export interface CloudMachine {
  readonly id: string;
  readonly name: string;
  readonly status: "starting" | "running" | "stopping" | "deleting" | "unknown";
  readonly region?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly address?: string;
}

export interface EnsureMachineInput {
  readonly identity: CapacityIdentity;
  readonly machineClass: MachineClass;
  readonly image: string;
  readonly location: string;
  readonly userData?: string;
  readonly state: FencedState;
}

export interface RemoveMachineInput {
  readonly identity: { readonly name: string; readonly labels: Readonly<Record<string, string>> };
  readonly state: FencedState;
}

/**
 * One cloud. The provider decides what to create and when; a port only knows
 * how, and never decides policy (sizes, caps, ownership). Reads (`find`,
 * `listManaged`) work from the cloud alone, so they hold when state is lost.
 */
export interface CloudPort {
  readonly provider: string;
  /** Create the machine, or adopt the one already carrying this deterministic name. */
  ensureMachine(input: EnsureMachineInput): Effect.Effect<CloudMachine, CapacityError>;
  /** Delete what provisioning state records for this identity. */
  removeMachine(input: RemoveMachineInput): Effect.Effect<void, CapacityError>;
  find(name: string): Effect.Effect<CloudMachine | undefined, CapacityError>;
  /** Machines labeled as managed by this platform. */
  listManaged(platformHash: string): Effect.Effect<readonly CloudMachine[], CapacityError>;
  /**
   * Delete a machine directly. Only the provider calls this, and only after it
   * proved the machine carries this platform's labels and provisioning state
   * could not remove it (state lost).
   */
  forceDelete(machine: CloudMachine): Effect.Effect<void, CapacityError>;
}
