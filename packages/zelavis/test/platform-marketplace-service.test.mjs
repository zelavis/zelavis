import assert from "node:assert/strict";
import test from "node:test";

import { marketplaceService } from "../dist/platform/marketplace-service.js";

test("Marketplace owns its Platform dashboard surface", () => {
  assert.equal(marketplaceService.name, "zelavis/marketplace");
  assert.equal(marketplaceService.menu.path, "/marketplace");
  assert.equal(marketplaceService.menu.surface, "platform");
});
