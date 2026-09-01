import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MARKETPLACE_MANIFEST } from "../dist/manifest.js";
import { createZelavisMarketplaceService } from "../dist/service.js";

test("the manifest module matches package.json", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  // The loader needs the manifest as a value, so it is duplicated as a module.
  // Drift would mean the marketplace loads under a stale identity.
  for (const field of ["name", "version", "type"]) {
    assert.equal(MARKETPLACE_MANIFEST[field], packageJson[field], field);
  }
  assert.deepEqual(MARKETPLACE_MANIFEST.exports["."], packageJson.exports["."]);
  assert.deepEqual(MARKETPLACE_MANIFEST.zelavis, packageJson.zelavis);
});

test("the marketplace contributes both menus through the SDK", async () => {
  const service = await createZelavisMarketplaceService();

  assert.equal(service.name, "@zelavis/marketplace");
  assert.equal(service.version, MARKETPLACE_MANIFEST.version);
  assert.equal(service.kind, "plugin");

  // Both menus arrived through `zelavis.menu.create` inside a plugin execution
  // context — the same path a third-party plugin takes.
  assert.equal(service.menus?.length, 2);
  const [platform, project] = service.menus;
  assert.equal(platform.surface, "platform");
  assert.equal(platform.path, "/marketplace");
  assert.equal(project.surface, "root");
  assert.deepEqual(project.access.scope, {
    type: "project",
    projectIdParam: "projectId",
  });
});

test("the marketplace ships the page its menus point at", async () => {
  const service = await createZelavisMarketplaceService();

  for (const menu of service.menus) {
    assert.ok(service.pageAssets?.[menu.page.file], menu.page.file);
  }
  assert.match(service.pageAssets["marketplace.html"].body, /<h1>Marketplace/);
});
