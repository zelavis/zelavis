import assert from "node:assert/strict";
import test from "node:test";

import { createZelavisCoreService } from "../dist/platform/core-service.js";

test("Zelavis core owns the Platform Server surface", () => {
  const service = createZelavisCoreService({ service: {}, routes: [] });

  assert.equal(service.name, "zelavis/platform");
  assert.equal(service.basePath, "/runtime");
  assert.equal(service.menu.title, "Server");
  assert.equal(service.menu.surface, "platform");
});
