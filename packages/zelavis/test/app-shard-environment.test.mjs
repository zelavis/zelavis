import assert from "node:assert/strict";
import test from "node:test";
import { APP_SHARD_VARIABLES, appShardConfiguration, appShardEnvironment, inheritedAppShardEnvironment } from "../dist/adapters/_app-shard-environment.js";
import { verifyAppShardCapability } from "../dist/platform/app-shard-capability.js";
import { loadPlatformMasterSecret } from "../dist/platform/master-secret.js";
import { createMemorySystemStore } from "../dist/system-store.js";

test("shards are off without ZELAVIS_APP_SHARDS_URL, and the URL must be an API root", () => {
  assert.equal(appShardConfiguration({}), undefined);
  assert.equal(appShardConfiguration({ ZELAVIS_APP_SHARDS_URL: "  " }), undefined);
  assert.throws(() => appShardConfiguration({ ZELAVIS_APP_SHARDS_URL: "http://127.0.0.1:3000/zelavis" }), /api\/v1/);
  assert.deepEqual(appShardConfiguration({ ZELAVIS_APP_SHARDS_URL: " http://127.0.0.1:3000/zelavis/api/v1 " }), { authority: "http://127.0.0.1:3000/zelavis/api/v1" });
});

test("a starting writer gets the authority and a capability for its Project, node and epoch", async () => {
  const store = createMemorySystemStore();
  const environment = await appShardEnvironment({ authority: "http://x/api/v1" }, store, "p1", "node-a", 4);
  assert.deepEqual(Object.keys(environment).sort(), [...APP_SHARD_VARIABLES].sort());
  assert.equal(environment.ZELAVIS_APP_SHARDS_AUTHORITY, "http://x/api/v1");
  const claims = await verifyAppShardCapability(await loadPlatformMasterSecret(store), environment.ZELAVIS_APP_SHARDS_TOKEN);
  assert.deepEqual(claims, { scope: "p1", node: "node-a", epoch: 4 });
});

test("a host hands its engine exactly the two shard variables", () => {
  assert.deepEqual(inheritedAppShardEnvironment({ ZELAVIS_APP_SHARDS_AUTHORITY: "a", ZELAVIS_APP_SHARDS_TOKEN: "t", ZELAVIS_APP_SHARDS_URL: "u", OTHER: "o" }),
    { ZELAVIS_APP_SHARDS_AUTHORITY: "a", ZELAVIS_APP_SHARDS_TOKEN: "t" });
  assert.deepEqual(inheritedAppShardEnvironment({}), {});
});
