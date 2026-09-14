import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";

const MARKETPLACE_PAGE = await readFile(
  new URL("../dashboard/marketplace.html", import.meta.url),
  "utf8",
);

test("the package.json manifest is automatically resolved and validated", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  assert.ok(manifest);
  assert.equal(manifest.name, "@zelavis/marketplace");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.zelavis.kind, "plugin");
  assert.equal(manifest.zelavis.namespace, "marketplace");
  assert.deepEqual(manifest.zelavis.capabilities, ["dashboard:menu", "marketplace:services"]);
});

test("the page is a complete document that styles itself from the Platform", () => {
  // It is loaded into a frame of its own rather than injected into the
  // dashboard, so a fragment would render as a broken page rather than fail.
  assert.match(MARKETPLACE_PAGE, /^<!doctype html>/);

  // The heading is declared to the Platform's page component rather than
  // written as markup, which is what lets the page inherit the installation's
  // chrome instead of drawing its own.
  assert.match(MARKETPLACE_PAGE, /<zv-page[^>]*heading="Marketplace"/);

  // Links the Platform's design tokens rather than shipping a palette, so the
  // page follows whatever the installation looks like.
  assert.match(MARKETPLACE_PAGE, /service-page\.css/);
  assert.doesNotMatch(MARKETPLACE_PAGE, /--background:|#[0-9a-f]{6}/i);
});

test("the service cannot be imported outside a plugin context", async () => {
  // The module contributes its menus by calling the SDK at evaluation time.
  // Importing it directly — composing it as a plain object the way the old
  // in-tree marketplace was — must fail loudly rather than yield a service
  // with no menus.
  await assert.rejects(
    () => import("../dist/index.js"),
    /plugin execution context/,
  );
});
