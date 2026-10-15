import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { zelavisUiFrontend } from "../src/frontend.ts";
const context = { rootPath: "/zelavis", createRuntimeConfig: () => Promise.resolve({}), devServerUrl: "http://127.0.0.1:3271/zelavis" };
test("registers through the SDK as an opt-in trusted frontend", async () => {
  const frontend = await zelavisUiFrontend(context);
  assert.equal(frontend.service.name, "@zelavis/ui");
  assert.equal(frontend.service.kind, "frontend");
  assert.equal(frontend.service.scope, "system");
  assert.equal(frontend.service.app.devUrl, context.devServerUrl);
  assert.ok(frontend.clientRoutes.includes("/projects/*"));
});
test("serves built assets and refuses traversal, missing files and foreign mounts", async () => {
  const frontend = await zelavisUiFrontend(context);
  const files = await readdir(new URL("../.fuzor/web/dist-spa/assets/", import.meta.url));
  const name = files.find(name => name.endsWith(".js"));
  const asset = await frontend.bundleStore.read({}, `assets/${name}`);
  assert.match(asset.contentType, /javascript/);
  assert.ok(asset.size > 0);
  assert.equal(await frontend.bundleStore.read({}, "../package.json"), undefined);
  assert.equal(await frontend.bundleStore.read({}, "assets/../../../package.json"), undefined);
  assert.equal(await frontend.bundleStore.read({}, "assets/missing.js"), undefined);
  await assert.rejects(zelavisUiFrontend({ ...context, rootPath: "no-leading-slash" }), /cannot be mounted/);
  // Any other mount serves the same build with its own root path applied and the build placeholder gone.
  const { readFile } = await import("node:fs/promises");
  let carrier;
  for (const name of files.filter(entry => entry.endsWith(".js"))) {
    if ((await readFile(new URL(`../.fuzor/web/dist-spa/assets/${name}`, import.meta.url), "utf8")).includes("/__zelavis__")) { carrier = name; break; }
  }
  assert.ok(carrier, "the build refers to its placeholder root somewhere");
  for (const [rootPath, expected] of [["/admin", "/admin"], ["/", ""]]) {
    const served = await zelavisUiFrontend({ ...context, rootPath });
    const text = new TextDecoder().decode((await served.bundleStore.read({}, `assets/${carrier}`)).body);
    assert.ok(!text.includes("__zelavis__"), `${rootPath} leaves no placeholder`);
    if (expected) assert.ok(text.includes(`${expected}/`), `${rootPath} names its own mount`);
  }
});
