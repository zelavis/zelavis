import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginPackage } from "../dist/service.js";

const MANIFEST = Object.freeze({
  name: "@acme/complete",
  version: "1.0.0",
  type: "module",
  exports: { ".": { import: "./dist/index.js" } },
  zelavis: { kind: "plugin", namespace: "example" },
});

/**
 * A plugin loaded through the loader must be the plugin that was written.
 *
 * The loader builds its own service object field by field, so anything it
 * forgets is silently dropped — the plugin installs, looks present, and does
 * less than it declared.
 */
async function load(service, options = {}) {
  return loadPluginPackage({
    manifest: MANIFEST,
    ...options,
    importer: async () => ({ default: service }),
  });
}

test("package menus must be registered through the SDK", async () => {
  for (const fields of [
    { menu: { title: "Example", path: "/example" } },
    { menus: [{ title: "Example", path: "/example" }] },
  ]) {
    await assert.rejects(
      load(fields),
      /must register menus with zelavis\.plugins\.ui\.menus\.create\(\)/,
    );
  }
});

test("a plugin that registers services during setup keeps its setup", async () => {
  const service = {
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
    authenticators: [authenticator],
    runtimeServices: [{ name: "acme-runtime", service: {} }],
    app: { mount: "/", bundle: "build" },
  }, {
    scope: "system",
    manifest: { ...MANIFEST, zelavis: { ...MANIFEST.zelavis, project: { runtimeKinds: ["native"] } } },
  });

  assert.equal(loaded.scope, "system");
  assert.equal(loaded.authenticators?.length, 1);
  assert.equal(loaded.runtimeServices?.length, 1);
  assert.ok(loaded.app);
  assert.ok(loaded.project);
});

test("a plugin declaring none of them is unchanged", async () => {
  const loaded = await load({});

  // Absent rather than present-and-undefined, so a service that declares
  // nothing is not mistaken for one that declared an empty value.
  assert.equal("setup" in loaded, false);
  assert.equal("app" in loaded, false);
  assert.equal("project" in loaded, false);
});

test("manifest-backed module resolution preserves default setup and API fields", async () => {
  const { resolveServiceModule } = await import("../dist/service.js");
  const setup = () => {};
  const api = { v1: [] };
  const resolved = resolveServiceModule({ default: { setup, api } }, MANIFEST);
  assert.equal(resolved.setup, setup);
  assert.equal(resolved.api, api);
  assert.equal(resolveServiceModule({ default: setup }, MANIFEST).setup, setup);
  assert.equal((await load(setup)).setup, setup);
});

test("SDK and exported authenticators are both preserved", async () => {
  const { zelavis } = await import("../dist/sdk/fetch.js");
  const sdkAuthenticator = { name: "sdk", authenticate: async () => undefined };
  const exportedAuthenticator = { name: "export", authenticate: async () => undefined };
  const loaded = await loadPluginPackage({ manifest: MANIFEST, importer: async () => {
    zelavis.context().authenticators.push(sdkAuthenticator);
    return { default: { authenticators: [exportedAuthenticator] } };
  } });
  assert.deepEqual(loaded.authenticators, [exportedAuthenticator, sdkAuthenticator]);
});
