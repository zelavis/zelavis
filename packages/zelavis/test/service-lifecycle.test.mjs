import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { pruneServicePackages } from "../dist/adapters/_local-runtime.js";

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("prune removes what the registry no longer points at, and only that", async (t) => {
  const root = await scratch(t);
  const services = join(root, "services");
  for (const digest of ["kept", "replaced-by-an-update", "uninstalled"]) {
    await mkdir(join(services, "packages", digest), { recursive: true });
    await writeFile(join(services, "packages", digest, "index.js"), "export {}");
  }
  await mkdir(join(services, ".tmp", "half-written"), { recursive: true });
  await mkdir(join(services, "dropped-in"), { recursive: true });

  const { removed } = await pruneServicePackages({
    directory: services,
    referencedSpecifiers: [
      join(services, "packages", "kept", "index.js"),
      "npm:@example/not-a-path",            // not a path in this folder
      "/somewhere/else/packages/uninstalled/index.js", // a different folder's package
    ],
  });

  assert.deepEqual((await readdir(join(services, "packages"))).sort(), ["kept"]);
  assert.deepEqual(removed.sort(), [".tmp", join("packages", "replaced-by-an-update"), join("packages", "uninstalled")].sort());
  assert.deepEqual((await readdir(services)).sort(), ["dropped-in", "packages"], "dropped-in services and the folder are untouched");
});

test("pruning a folder that has no packages is a no-op", async (t) => {
  const root = await scratch(t);
  assert.deepEqual((await pruneServicePackages({ directory: join(root, "nothing"), referencedSpecifiers: [] })).removed, []);
});

test("an uninstall says the old code stays loaded until a restart; an install does not", async (t) => {
  const root = await scratch(t);
  const checkout = join(root, "zelavis-services");
  await mkdir(join(checkout, "shop"), { recursive: true });
  await writeFile(join(checkout, "shop", "package.json"), JSON.stringify({
    name: "@zelavis/shop", version: "1.0.0", type: "module", exports: "./index.js",
    zelavis: { kind: "plugin", namespace: "shop", marketplace: { title: "Shop" } },
  }));
  await writeFile(join(checkout, "shop", "index.js"), "export function register() {}");

  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: join(root, "data"), services: { marketplace: { sources: [], officialServicesDirectory: checkout } } }) });
  t.after(() => zv.close());
  const owner = { principal: { id: "o", type: "user", roles: ["owner"], permissions: ["*"] } };
  const patch = async (status) => {
    const response = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/services/%40zelavis%2Fshop", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
    }), owner);
    assert.equal(response.status, 200);
    return (await response.json()).activation;
  };

  const installed = await patch("installed");
  assert.equal(installed.status, "active");
  assert.equal(installed.restartRecommended, undefined, "adding code needs no restart");

  const removed = await patch("available");
  assert.equal(removed.status, "active", "the service stops at once");
  assert.equal(removed.restartRecommended, true);
  assert.match(removed.message, /@zelavis\/shop is uninstalled\. The previous code stays in memory until the Platform restarts/);
});
