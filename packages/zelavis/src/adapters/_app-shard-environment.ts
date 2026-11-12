import * as Effect from "effect/Effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { mintAppShardCapability } from "../platform/app-shard-capability.js";
import { loadPlatformMasterSecret } from "../platform/master-secret.js";
import type { ZelavisSystemStore } from "../system-store.js";

/**
 * Remote App shards for the Projects this Platform starts. Off unless the operator names where a Project process reaches
 * the Platform: `ZELAVIS_APP_SHARDS_URL`, the Platform's API root as that process sees it (`http://127.0.0.1:3000/zelavis/api/v1`
 * for Projects on the Platform's own host). Without it no capability is minted and a Project cannot place a shard remotely.
 */
export interface AppShardConfiguration {
  readonly authority: string;
}

export const appShardConfiguration = (environment: Readonly<Record<string, string | undefined>> = process.env): AppShardConfiguration | undefined => {
  const authority = environment.ZELAVIS_APP_SHARDS_URL?.trim();
  if (!authority) return undefined;
  if (!/\/api\/v1\/?$/.test(authority)) throw new Error("ZELAVIS_APP_SHARDS_URL is the Platform's API root, ending in /api/v1.");
  return { authority };
};

/** What a starting writer is given: where to reach the Platform, and a capability for this Project, this node and this epoch. */
export const appShardEnvironment = (configuration: AppShardConfiguration, store: ZelavisSystemStore, projectId: string, nodeId: string, epoch: number): Promise<Readonly<Record<string, string>>> =>
  present(Effect.gen(function* () {
    const secret = yield* integration(() => loadPlatformMasterSecret(store));
    const token = yield* integration(() => mintAppShardCapability(secret, { scope: projectId, node: nodeId, epoch }));
    return { ZELAVIS_APP_SHARDS_AUTHORITY: configuration.authority, ZELAVIS_APP_SHARDS_TOKEN: token };
  }));

export const APP_SHARD_VARIABLES: readonly string[] = Object.freeze(["ZELAVIS_APP_SHARDS_AUTHORITY", "ZELAVIS_APP_SHARDS_TOKEN"]);

/** The shard variables a Project's host process was started with, for the engine process it starts in turn (which gets an allow-listed environment). */
export const inheritedAppShardEnvironment = (environment: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<string, string>> =>
  Object.fromEntries(APP_SHARD_VARIABLES.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]]));
