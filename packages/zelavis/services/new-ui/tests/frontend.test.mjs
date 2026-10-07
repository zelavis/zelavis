import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { newUiFrontend } from "../src/frontend.ts";
const context = { rootPath: "/zelavis", createRuntimeConfig: () => Promise.resolve({}), devServerUrl: "http://127.0.0.1:3271/zelavis" };
test("registers through the SDK as an opt-in trusted frontend", async () => {
  const frontend = await newUiFrontend(context);
  assert.equal(frontend.service.name, "@zelavis/new-ui");
  assert.equal(frontend.service.kind, "frontend");
  assert.equal(frontend.service.scope, "system");
  assert.equal(frontend.service.app.devUrl, context.devServerUrl);
  assert.ok(frontend.clientRoutes.includes("/projects/*"));
});
test("serves built assets and refuses traversal, missing files and foreign mounts", async () => {
  const frontend = await newUiFrontend(context);
  const files = await readdir(new URL("../dist-spa-server/client/assets/", import.meta.url));
  const name = files.find(name => name.endsWith(".js"));
  const asset = await frontend.bundleStore.read({}, `assets/${name}`);
  assert.match(asset.contentType, /javascript/);
  assert.ok(asset.size > 0);
  assert.equal(await frontend.bundleStore.read({}, "../package.json"), undefined);
  assert.equal(await frontend.bundleStore.read({}, "assets/../../../package.json"), undefined);
  assert.equal(await frontend.bundleStore.read({}, "assets/missing.js"), undefined);
  await assert.rejects(newUiFrontend({ ...context, rootPath: "/different" }), /currently mounts at/);
});
