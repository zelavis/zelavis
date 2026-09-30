import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The services model on the Bun adapter, run under real Bun. Skipped where Bun
// is not installed; on a host that has it, Node and Bun must agree.
const bun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

function observe() {
  const child = spawnSync("bun", [new URL("./fixtures/bun-services-check.mjs", import.meta.url).pathname], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("the Bun adapter serves the services model like the Node adapter", { skip: !bun && "bun is not installed" }, () => {
  const seen = observe();
  assert.equal(seen.runtime, "bun");

  // Platform: official catalog, a dropped-in package, a folder frontend that
  // stays under its own prefix and cannot take the root.
  assert.deepEqual(seen.platform.registry, [
    "@acme/blog-frontend:installed:community",
    "@acme/hello:installed:community",
    "@zelavis/app:available:official",
    "@zelavis/auth:installed:official",
    "@zelavis/marketplace:installed:official",
  ]);
  assert.deepEqual(seen.platform.folderApi, { status: 200, body: { hello: "from the folder" } });
  assert.deepEqual(seen.platform.folderFrontend, { status: 200, body: "<h1>blog</h1>" });
  assert.equal(seen.platform.rootIsNotTheFrontend, true);

  // Project: its own folder, its own frontend at the root, selection by
  // installing, and the choice survives a restart.
  assert.deepEqual(seen.project.folderApi, { status: 200, body: { hello: "from the folder" } });
  assert.equal(seen.project.site, "<h1>first site</h1>");
  assert.equal(seen.project.apiStillServed, 200);
  assert.equal(seen.project.afterSelect, "<h1>second site</h1>");
  assert.equal(seen.project.afterRestart, "<h1>second site</h1>");
});
