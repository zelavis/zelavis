import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformEndpointGroup } from "../dist/platform/endpoints.js";

test("the Server Control Plane is a native endpoint group, not a service", () => {
  const group = createPlatformEndpointGroup({ context: {}, routes: [] });

  assert.equal(group.id, "platform.control-plane");
  assert.equal(group.basePath, "/runtime");
  assert.equal(group.origin.type, "subsystem");
  assert.equal("menu" in group, false);
  assert.equal("kind" in group, false);
});
