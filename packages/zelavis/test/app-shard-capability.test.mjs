import assert from "node:assert/strict";
import test from "node:test";
import { mintAppShardCapability, verifyAppShardCapability } from "../dist/platform/app-shard-capability.js";
import { mintLeaseCapability } from "../dist/platform/lease-capability.js";

const SECRET = "secret-one";

test("a capability round-trips its claims", async () => {
  const token = await mintAppShardCapability(SECRET, { scope: "p1", node: "node-a", epoch: 7 });
  assert.deepEqual(await verifyAppShardCapability(SECRET, token), { scope: "p1", node: "node-a", epoch: 7 });
});

test("a tampered token, a lease capability and another secret are not authorized", async () => {
  const token = await mintAppShardCapability(SECRET, { scope: "p1", node: "node-a", epoch: 7 });
  const flipped = `${token.slice(0, 3)}${token[3] === "A" ? "B" : "A"}${token.slice(4)}`;
  assert.equal(await verifyAppShardCapability(SECRET, flipped), undefined);
  const lease = await mintLeaseCapability(SECRET, { scope: "p1", node: "node-a" });
  assert.equal(await verifyAppShardCapability(SECRET, lease), undefined);
  assert.equal(await verifyAppShardCapability("secret-two", token), undefined);
  assert.equal(await verifyAppShardCapability(SECRET, "nonsense"), undefined);
});

test("a capability refuses epoch 0 and odd names at mint", async () => {
  await assert.rejects(mintAppShardCapability(SECRET, { scope: "p1", node: "node-a", epoch: 0 }));
  await assert.rejects(mintAppShardCapability(SECRET, { scope: "p 1", node: "node-a", epoch: 1 }));
});
