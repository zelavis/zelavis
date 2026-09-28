import assert from "node:assert/strict";
import test from "node:test";
import {
  declaresServiceCapability,
  parseServiceCapability,
  serviceCapabilityFor,
  validatePluginPackageManifest,
} from "../dist/core/index.js";

test("a Platform namespace capability parses as one", () => {
  assert.deepEqual(parseServiceCapability("provider:auth"), {
    owner: "provider",
    name: "auth",
    serviceOwned: false,
  });
});

test("a package can own the capability providers declare into", () => {
  // This is the point of the grammar: `provider:payments` says what interface
  // a plugin implements but not whose contract it satisfies, so two
  // plugins scanning for it pick up each other's providers.
  assert.deepEqual(parseServiceCapability("@acme/shop:payments"), {
    owner: "@acme/shop",
    name: "payments",
    serviceOwned: true,
  });
});

test("a scoped owner is split on the last colon, not the scope", () => {
  const parsed = parseServiceCapability("zelavis/identity:credentials");
  assert.equal(parsed.owner, "zelavis/identity");
  assert.equal(parsed.name, "credentials");
});

test("malformed capabilities are rejected rather than half-understood", () => {
  for (const capability of [
    "provider",
    "@zelavis/auth:",
    ":credentials",
    "a:B",
    "@zelavis/auth:credentials:extra",
    "Provider:Auth",
    "",
  ]) {
    assert.equal(
      parseServiceCapability(capability),
      undefined,
      `expected ${JSON.stringify(capability)} to be rejected`,
    );
  }
});

test("building a capability refuses an owner that cannot be parsed back", () => {
  assert.equal(
    serviceCapabilityFor("zelavis/identity", "credentials"),
    "zelavis/identity:credentials",
  );
  assert.throws(() => serviceCapabilityFor("Not A Package", "x"), /not a valid/u);
});

test("declaring is an exact match, never a lookalike owner", () => {
  const capabilities = ["zelavis/identity:credentials"];
  assert.equal(declaresServiceCapability(capabilities, "zelavis/identity", "credentials"), true);
  // A package whose name merely starts the same must not be discovered as a
  // provider for another one.
  assert.equal(declaresServiceCapability(capabilities, "@zelavis/auth-extra", "credentials"), false);
  assert.equal(declaresServiceCapability(capabilities, "zelavis/identity", "payments"), false);
  assert.equal(declaresServiceCapability(undefined, "zelavis/identity", "credentials"), false);
});

test("a manifest carrying an invalid capability is refused at validation", () => {
  const manifest = (capabilities) => ({
    name: "@acme/thing",
    type: "module",
    exports: "./index.js",
    zelavis: { kind: "plugin", namespace: "example", capabilities },
  });

  assert.doesNotThrow(() =>
    validatePluginPackageManifest(manifest(["zelavis/identity:credentials", "api:routes"])),
  );
  assert.throws(() => validatePluginPackageManifest(manifest(["NotValid"])), /not a valid capability/u);
  assert.throws(() => validatePluginPackageManifest(manifest("api:routes")), /must be an array/u);
});

test("manifest capabilities reach the loaded service", async () => {
  const { loadPluginPackage } = await import("../dist/service.js");
  const manifest = {
    name: "@acme/provider",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
    zelavis: { kind: "plugin", namespace: "example", capabilities: ["zelavis/identity:credentials"] },
  };

  // A service object that does not restate its capabilities is not opting out.
  // Dropping them here made an installed provider extend nothing: it loaded,
  // registered, and was then never discovered by the plugin it named.
  const declared = await loadPluginPackage({
    manifest,
    importer: async () => ({ default: { service: { register() {} } } }),
  });
  assert.deepEqual(declared.capabilities, ["zelavis/identity:credentials"]);

  // Exported metadata is rejected so it cannot silently diverge from the manifest.
  await assert.rejects(loadPluginPackage({
    manifest,
    importer: async () => ({ default: { capabilities: ["api:routes"] } }),
  }), /not a module export/);
});
