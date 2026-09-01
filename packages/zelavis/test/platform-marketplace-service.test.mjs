import assert from "node:assert/strict";
import test from "node:test";

import {
  createZelavisMarketplaceService,
  zelavisMarketplaceMenu,
  zelavisProjectMarketplaceMenu,
} from "@zelavis/ui/marketplace";

test("Marketplace owns its Platform dashboard surface", () => {
  const service = createZelavisMarketplaceService({ version: "1.0.0-test" });
  assert.equal(service.name, "zelavis/marketplace");
  assert.equal(service.kind, "core");
  assert.equal(service.menu.path, "/marketplace");
  assert.equal(service.menu.surface, "platform");
  assert.deepEqual(service.menu.access.permissions, ["marketplace.view"]);
});

test("the project marketplace is a distinct surface with its own permission", () => {
  // Not a variant of the platform menu: a different surface, a different
  // permission, and previously a literal in the dashboard backed by no service.
  assert.equal(zelavisProjectMarketplaceMenu.surface, "root");
  assert.deepEqual(zelavisProjectMarketplaceMenu.access.permissions, [
    "project.marketplace.manage",
  ]);
  assert.equal(
    zelavisProjectMarketplaceMenu.access.scope.projectIdParam,
    "projectId",
  );

  assert.notEqual(
    zelavisMarketplaceMenu.surface,
    zelavisProjectMarketplaceMenu.surface,
  );
});
