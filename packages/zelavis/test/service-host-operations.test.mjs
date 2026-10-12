import assert from "node:assert/strict";
import test from "node:test";

import { installAsyncPluginContextStorage } from "../dist/adapters/_async-plugin-context.js";
import { validatePluginPackageManifest } from "../dist/core/service/manifest.js";
import { scopeHostOperations } from "../dist/platform/service-host-operations.js";
import { activateServiceRegistry, loadPluginPackage, ZelavisHostOperationNotFoundError } from "../dist/index.js";

installAsyncPluginContextStorage();

const manifest = (zelavis, extra = {}) => ({ name: "@acme/builds", version: "1.0.0", type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace: "builds", ...zelavis }, ...extra });

test("a plugin manifest may name a few distinct fixed host operations; nothing else may", () => {
  validatePluginPackageManifest(manifest({ hostOperations: ["zelavis.container-probe", "zelavis.host-report"] }));
  assert.throws(() => validatePluginPackageManifest(manifest({ hostOperations: ["rm -rf /"] })), /operation ids/);
  assert.throws(() => validatePluginPackageManifest(manifest({ hostOperations: ["zelavis.host-report", "zelavis.host-report"] })), /distinct/);
  assert.throws(() => validatePluginPackageManifest(manifest({ hostOperations: "zelavis.host-report" })), /operation ids/);
  assert.throws(() => validatePluginPackageManifest(manifest({ hostOperations: Array.from({ length: 9 }, (_, index) => `zelavis.op-${index}`) })), /at most eight/);
  assert.throws(() => validatePluginPackageManifest({ ...manifest({ hostOperations: ["zelavis.host-report"] }), zelavis: { kind: "app", namespace: "builds", hostOperations: ["zelavis.host-report"], project: { runtimeKinds: ["native"] } } }), /only for plugins/);
});

test("only the manifest grants host operations, never the module's own exports", async () => {
  const granted = await loadPluginPackage({ manifest: manifest({ hostOperations: ["zelavis.host-report"] }), importer: async () => ({}) });
    assert.deepEqual([...granted.hostOperations], ["zelavis.host-report"]);
  await assert.rejects(
    loadPluginPackage({ manifest: manifest({}), importer: async () => ({ hostOperations: ["zelavis.packages-install"] }) }),
    /must declare hostOperations through its manifest/,
  );
});

const principal = { id: "owner", type: "user" };
const recordOf = (operation) => ({ operationId: "op1", operation, version: "v1", status: "accepted" });
function fakeBroker() {
  const calls = [];
  return {
    calls,
    catalog: async () => [],
    submit: async (input, who) => { calls.push(["submit", input.operation, who]); return recordOf(input.operation); },
    get: async (id) => { calls.push(["get", id]); return recordOf(id === "other" ? "zelavis.packages-install" : "zelavis.container-probe"); },
    audit: async () => [],
  };
}

test("the handle submits only what the manifest names, carrying the caller's principal", async () => {
  const broker = fakeBroker();
  const handle = scopeHostOperations(broker, ["zelavis.container-probe"]);
  assert.deepEqual([...handle.allowed], ["zelavis.container-probe"]);
  assert.equal((await handle.submit({ operation: "zelavis.container-probe", version: "v1", arguments: {} }, principal)).operation, "zelavis.container-probe");
  assert.deepEqual(broker.calls[0], ["submit", "zelavis.container-probe", principal], "the broker sees the caller, not the plugin");
  await assert.rejects(handle.submit({ operation: "zelavis.packages-install", version: "v1", arguments: { set: "mariadb-server" } }, principal), ZelavisHostOperationNotFoundError);
  assert.equal(broker.calls.length, 1, "a refused operation never reaches the broker");
  assert.equal((await handle.get("known", principal)).operation, "zelavis.container-probe");
  await assert.rejects(handle.get("other", principal), ZelavisHostOperationNotFoundError, "a record of an operation it could not name is not its to read");
  assert.throws(() => { handle.allowed.push("zelavis.packages-install"); }, TypeError, "the allow-list cannot be widened");
});

test("activation gives the handle to a service whose manifest names operations, and to no other", async () => {
  const seen = {};
  const service = (name, hostOperations) => Object.freeze({
    name, kind: "plugin", ...(hostOperations ? { hostOperations } : {}),
    setup: (context) => { seen[name] = context.core.hostOperations; },
  });
  await activateServiceRegistry(
    [{ service: service("@acme/with", ["zelavis.container-probe"]), status: "installed" }, { service: service("@acme/without"), status: "installed" }],
    { rootPath: "/", api: { prefix: "/api", version: "v1", basePath: "/api/v1" }, platform: { presets: [], resources: { keyValueStore: false, fileStorage: false }, metadata: {} }, core: {} },
    { hostOperations: (name, allowed) => scopeHostOperations(fakeBroker(), allowed) },
  );
  assert.deepEqual([...seen["@acme/with"].allowed], ["zelavis.container-probe"]);
  assert.equal(seen["@acme/without"], undefined);
});
