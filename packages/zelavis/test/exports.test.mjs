import assert from "node:assert/strict";
import test from "node:test";

test("zelavis package exports runtime APIs and integration subpaths", async () => {
  const runtime = await import("zelavis");
  const nodeIntegration = await import("zelavis/integrations/node");
  const expressIntegration = await import("zelavis/integrations/express");
  const honoIntegration = await import("zelavis/integrations/hono");

  assert.equal(typeof runtime.zelavis, "function");
  assert.equal(typeof nodeIntegration.nodeIntegration, "function");
  assert.equal(typeof expressIntegration.expressIntegration, "function");
  assert.equal(typeof honoIntegration.honoIntegration, "function");
});
