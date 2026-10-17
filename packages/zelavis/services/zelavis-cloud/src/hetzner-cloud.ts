import * as Hetzner from "@distilled.cloud/hetzner";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Alchemy from "alchemy";
import * as AlchemyHetzner from "alchemy/Hetzner";
import type { State } from "alchemy/State";
import { makeAlchemyRunner } from "./alchemy-runner.js";
import { MANAGED_LABEL, PLATFORM_LABEL, deployKeyName } from "./capacity-naming.js";
import { CapacityError } from "./capacity-error.js";
import type { CloudKey, CloudMachine, CloudPort, EnsureMachineInput, RemoveMachineInput } from "./cloud-port.js";

/**
 * The Hetzner implementation of `CloudPort`.
 *
 * Creating and deleting a machine goes through Alchemy, which owns the resource
 * lifecycle (create, adopt by name, replace, delete) and persists its progress
 * in the fenced provisioning state. Reading the cloud (find, list) and the
 * last-resort delete of an orphan go straight to the Hetzner API, because they
 * are observations and must not depend on any state being intact.
 */
export interface HetznerCloudOptions {
  readonly token: string;
  /** Override the API root, for a fake in tests. */
  readonly endpoint?: string;
  /** Alchemy's home and working directory. */
  readonly workDir: string;
}

const PAGE_SIZE = 50;
/** Bounded so a runaway listing cannot grow without limit. */
const MAX_PAGES = 20;

export interface HetznerCapacityStackInput {
  readonly identity: { readonly name?: string; readonly labels: Readonly<Record<string, string>> };
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  readonly userData?: string;
  /** Alchemy's stack and stage are the ones this state was acquired for. */
  readonly state: { readonly layer: Layer.Layer<State>; readonly stack: string; readonly stage: string };
}

/** The Alchemy stack for one provisioned machine. */
export function hetznerCapacityStack(input: HetznerCapacityStackInput) {
  const { identity, serverType, image, location, userData, state } = input;
  return Alchemy.Stack(
    state.stack,
    { providers: AlchemyHetzner.providers(), state: state.layer },
    Effect.gen(function* () {
      const node = yield* AlchemyHetzner.Server("node", {
        ...(identity.name === undefined ? {} : { name: identity.name }),
        serverType,
        image,
        location,
        labels: { ...identity.labels },
        ...(userData === undefined ? {} : { userData }),
      });
      return { id: node.id, name: node.name };
    }),
  );
}

const statusOf = (status: string): CloudMachine["status"] => {
  switch (status) {
    case "running":
      return "running";
    case "initializing":
    case "starting":
    case "migrating":
    case "rebuilding":
      return "starting";
    case "stopping":
    case "off":
      return "stopping";
    case "deleting":
      return "deleting";
    default:
      return "unknown";
  }
};

interface HetznerServerLike {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly location: { readonly name: string };
  readonly public_net: { readonly ipv4?: { readonly ip?: string } | null };
}

const machineFrom = (server: HetznerServerLike): CloudMachine => ({
  id: String(server.id),
  name: server.name,
  status: statusOf(server.status),
  region: server.location.name,
  labels: { ...server.labels },
  ...(server.public_net.ipv4?.ip === undefined ? {} : { address: server.public_net.ipv4.ip }),
});

interface HetznerKeyLike {
  readonly id: number;
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>> | null;
  readonly created?: string | null;
}

const keyFrom = (key: HetznerKeyLike): CloudKey => ({
  id: String(key.id),
  name: key.name,
  labels: { ...(key.labels ?? {}) },
  createdAt: key.created ? Date.parse(key.created) || 0 : 0,
});

export function createHetznerCloud(options: HetznerCloudOptions): CloudPort {
  const config: Record<string, string> = { HCLOUD_TOKEN: options.token };
  if (options.endpoint !== undefined) config.HCLOUD_ENDPOINT = options.endpoint;
  const runner = makeAlchemyRunner({ config, workDir: options.workDir });
  const api = Layer.mergeAll(
    Hetzner.credentials({
      token: options.token,
      ...(options.endpoint === undefined ? {} : { apiBaseUrl: options.endpoint }),
    }),
    FetchHttpClient.layer,
  );

  const cloudFailure = (operation: string) => (cause: unknown) =>
    cause instanceof CapacityError ? cause : new CapacityError("cloud", `Hetzner ${operation} failed`, cause);

  const removeKey = (key: CloudKey) =>
    Hetzner.sshKeys.deleteSshKey({ id: Number(key.id) }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.provide(api),
      Effect.mapError(cloudFailure("key delete")),
    );

  const find = (name: string) =>
    Hetzner.servers.listServers({ name, per_page: PAGE_SIZE }).pipe(
      Effect.map(({ servers }) => (servers ?? []).find((server) => server.name === name)),
      Effect.map((server) => (server === undefined ? undefined : machineFrom(server as never))),
      Effect.provide(api),
      Effect.mapError(cloudFailure("lookup")),
    );

  const listManaged = (platformHash: string) =>
    Effect.gen(function* () {
      const found: CloudMachine[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = yield* Hetzner.servers.listServers({
          label_selector: `${MANAGED_LABEL}=true,${PLATFORM_LABEL}=${platformHash}`,
          per_page: PAGE_SIZE,
          page,
        });
        for (const server of response.servers ?? []) found.push(machineFrom(server as never));
        if (!response.meta?.pagination?.next_page) return found;
      }
      return yield* Effect.fail(new CapacityError("cloud", `More than ${MAX_PAGES * PAGE_SIZE} managed machines; refusing to list`));
    }).pipe(Effect.provide(api), Effect.mapError(cloudFailure("list")));

  return {
    provider: "hetzner",
    find,
    listManaged,
    ensureMachine: (input: EnsureMachineInput) =>
      Effect.gen(function* () {
        const stack = hetznerCapacityStack({
          identity: input.identity,
          serverType: input.machineClass.name,
          image: input.image,
          location: input.location,
          ...(input.userData === undefined ? {} : { userData: input.userData }),
          state: input.state,
        });
        yield* runner.deploy({ stack, stage: input.state.stage, state: input.state });
        const machine = yield* find(input.identity.name);
        if (machine === undefined) {
          return yield* Effect.fail(new CapacityError("cloud", "Deploy finished but the machine cannot be found"));
        }
        return machine;
      }).pipe(Effect.mapError(cloudFailure("create"))),
    removeMachine: (input: RemoveMachineInput) =>
      Effect.gen(function* () {
        // Destroy runs from state; the declared properties are not consulted.
        const stack = hetznerCapacityStack({
          identity: input.identity,
          serverType: "unused",
          image: "unused",
          location: "unused",
          state: input.state,
        });
        yield* runner.destroy({ stack, stage: input.state.stage, state: input.state });
      }).pipe(Effect.mapError(cloudFailure("delete"))),
    listManagedKeys: (platformHash: string) =>
      Effect.gen(function* () {
        const found: CloudKey[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const response = yield* Hetzner.sshKeys.listSshKeys({
            label_selector: `${MANAGED_LABEL}=true,${PLATFORM_LABEL}=${platformHash}`,
            per_page: PAGE_SIZE,
            page,
          });
          for (const key of response.ssh_keys ?? []) found.push(keyFrom(key as never));
          if (!response.meta?.pagination?.next_page) return found;
        }
        return yield* Effect.fail(new CapacityError("cloud", `More than ${MAX_PAGES * PAGE_SIZE} managed keys; refusing to list`));
      }).pipe(Effect.provide(api), Effect.mapError(cloudFailure("key list"))),
    deleteKey: (key: CloudKey) => removeKey(key),
    forceDelete: (machine: CloudMachine) =>
      Effect.gen(function* () {
        yield* Hetzner.servers.deleteServer({ id: Number(machine.id) }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.provide(api),
          Effect.mapError(cloudFailure("delete")),
        );
        // The deploy key Alchemy generated beside it. Its name is derived from the machine's, and it is removed only
        // when it carries this platform's labels, so a foreign key of the same name is never touched.
        const keyName = deployKeyName(machine.name);
        const { ssh_keys } = yield* Hetzner.sshKeys.listSshKeys({ name: keyName, per_page: PAGE_SIZE }).pipe(Effect.provide(api), Effect.mapError(cloudFailure("key lookup")));
        const key = (ssh_keys ?? []).map(key => keyFrom(key as never)).find(candidate => candidate.name === keyName);
        if (key !== undefined && key.labels[MANAGED_LABEL] === "true" && key.labels[PLATFORM_LABEL] === machine.labels[PLATFORM_LABEL]) yield* removeKey(key);
      }),
  };
}
