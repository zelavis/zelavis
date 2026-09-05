import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginPackage } from "../dist/service.js";

const MANIFEST = Object.freeze({
  name: "@acme/complete",
  version: "1.0.0",
  type: "module",
  exports: { ".": { import: "./dist/index.js" } },
  zelavis: { kind: "plugin" },
});

/**
 * A plugin loaded through the loader must be the plugin that was written.
 *
 * The loader builds its own service object field by field, so anything it
 * forgets is silently dropped — the plugin installs, looks present, and does
 * less than it declared.
 */
async function load(service) {
  return loadPluginPackage({
    manifest: MANIFEST,
    importer: async () => ({ default: service }),
  });
}

test("a plugin that registers services during setup keeps its setup", async () => {
  const service = {
    name: "@acme/complete",
    setup(context) {
      context.addService({ name: "acme-inner", basePath: "/inner", service: {} });
    },
  };

  // Dropping this made the ecommerce plugin lose its entire `commerce` API
  // when installed as a package, while composing the same object in code
  // worked — so the supported path was the broken one.
  const loaded = await load(service);
  assert.equal(typeof loaded.setup, "function");
});

test("the loader carries the rest of what a plugin declares", async () => {
  const authenticator = { name: "acme", authenticate: async () => undefined };
  const loaded = await load({
    name: "@acme/complete",
    scope: "system",
    authenticators: [authenticator],
    runtimeServices: [{ name: "acme-runtime", service: {} }],
    app: { mount: "/", bundle: "build" },
    project: { id: "acme", title: "Acme" },
  });

  assert.equal(loaded.scope, "system");
  assert.equal(loaded.authenticators?.length, 1);
  assert.equal(loaded.runtimeServices?.length, 1);
  assert.ok(loaded.app);
  assert.ok(loaded.project);
});

test("a plugin declaring none of them is unchanged", async () => {
  const loaded = await load({ name: "@acme/complete" });

  // Absent rather than present-and-undefined, so a service that declares
  // nothing is not mistaken for one that declared an empty value.
  assert.equal("setup" in loaded, false);
  assert.equal("app" in loaded, false);
  assert.equal("project" in loaded, false);
});
