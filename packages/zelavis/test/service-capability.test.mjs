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
  // a plugin implements but not whose contract it satisfies, so two commerce
  // plugins scanning for it pick up each other's providers.
  assert.deepEqual(parseServiceCapability("@zelavis/ecommerce:payments"), {
    owner: "@zelavis/ecommerce",
    name: "payments",
    serviceOwned: true,
  });
});

test("a scoped owner is split on the last colon, not the scope", () => {
  const parsed = parseServiceCapability("zelavis/auth:credentials");
  assert.equal(parsed.owner, "zelavis/auth");
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
    serviceCapabilityFor("zelavis/auth", "credentials"),
    "zelavis/auth:credentials",
  );
  assert.throws(() => serviceCapabilityFor("Not A Package", "x"), /not a valid/u);
});

test("declaring is an exact match, never a lookalike owner", () => {
  const capabilities = ["zelavis/auth:credentials"];
  assert.equal(declaresServiceCapability(capabilities, "zelavis/auth", "credentials"), true);
  // A package whose name merely starts the same must not be discovered as a
  // provider for another one.
  assert.equal(declaresServiceCapability(capabilities, "@zelavis/auth-extra", "credentials"), false);
  assert.equal(declaresServiceCapability(capabilities, "zelavis/auth", "payments"), false);
  assert.equal(declaresServiceCapability(undefined, "zelavis/auth", "credentials"), false);
});

test("a manifest carrying an invalid capability is refused at validation", () => {
  const manifest = (capabilities) => ({
    name: "@acme/thing",
    type: "module",
    exports: "./index.js",
    zelavis: { kind: "plugin", capabilities },
  });

  assert.doesNotThrow(() =>
    validatePluginPackageManifest(manifest(["zelavis/auth:credentials", "api:routes"])),
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
    zelavis: { kind: "plugin", capabilities: ["zelavis/auth:credentials"] },
  };

  // A service object that does not restate its capabilities is not opting out.
  // Dropping them here made an installed provider extend nothing: it loaded,
  // registered, and was then never discovered by the plugin it named.
  const declared = await loadPluginPackage({
    manifest,
    importer: async () => ({ default: { name: "@acme/provider", service: { register() {} } } }),
  });
  assert.deepEqual(declared.capabilities, ["zelavis/auth:credentials"]);

  // A module that names its own capabilities still wins.
  const explicit = await loadPluginPackage({
    manifest,
    importer: async () => ({
      default: { name: "@acme/provider", capabilities: ["api:routes"], service: {} },
    }),
  });
  assert.deepEqual(explicit.capabilities, ["api:routes"]);
});
