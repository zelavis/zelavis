import assert from "node:assert/strict";
import test from "node:test";

import { installAsyncPluginContextStorage } from "../dist/adapters/_async-plugin-context.js";
import { loadPluginPackage, ZelavisPluginAdmissionError } from "../dist/service.js";
import { zelavis } from "../dist/sdk/fetch.js";

installAsyncPluginContextStorage();

const manifest = (namespace) => ({
  name: `@admission/${namespace}`,
  version: "1.0.0",
  type: "module",
  exports: "./index.js",
  zelavis: { kind: "plugin", namespace },
});

const operation = (resource) => zelavis.operations.create({
  id: `${resource}.list`,
  resource,
  action: "list",
  method: "GET",
  path: `/${resource}`,
  spec: { operationId: `list${resource}` },
  handler: () => ({ status: 200, body: {} }),
});

test("a stalled import misses its deadline, frees admission, and can never register", async () => {
  let resumeStalled;
  const stalledResumed = new Promise((resolve) => { resumeStalled = resolve; });
  let lateRegistration;
  const stalled = loadPluginPackage({
    manifest: manifest("stalled"),
    admissionTimeoutMs: 100,
    importer: async () => {
      await stalledResumed;
      try {
        operation("late");
        lateRegistration = "registered";
      } catch (error) {
        lateRegistration = error.message;
      }
      return {};
    },
  });
  await assert.rejects(stalled, (error) => {
    assert.ok(error instanceof ZelavisPluginAdmissionError);
    assert.match(error.message, /@admission\/stalled.*100 ms/);
    return true;
  });

  // Admission is free again and the next package owns its own context.
  const next = await loadPluginPackage({
    manifest: manifest("next"),
    importer: async () => {
      operation("items");
      // The stalled package resumes while this one is still loading.
      resumeStalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {};
    },
  });
  assert.deepEqual(next.api.v1.map((route) => route.meta?.pluginResource), ["items"]);
  assert.match(lateRegistration, /can no longer register: its load exceeded the 100 ms admission deadline/);
});

test("overlapping loads keep every registration in its own package", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = loadPluginPackage({
    manifest: manifest("first"),
    importer: async () => {
      await firstGate;
      operation("alpha");
      return {};
    },
  });
  const second = await loadPluginPackage({
    manifest: manifest("second"),
    importer: async () => {
      operation("beta");
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 10));
      operation("gamma");
      return {};
    },
  });
  const loadedFirst = await first;
  assert.deepEqual(loadedFirst.api.v1.map((route) => route.meta.pluginResource), ["alpha"]);
  assert.deepEqual(second.api.v1.map((route) => route.meta.pluginResource), ["beta", "gamma"]);
});

test("admission deadline must be a positive integer", async () => {
  await assert.rejects(
    loadPluginPackage({ manifest: manifest("bad"), admissionTimeoutMs: 0, importer: async () => ({}) }),
    /admissionTimeoutMs/,
  );
});

test("a setup hook that never finishes fails composition by name and cannot add services later", async () => {
  const { activateServiceRegistry } = await import("../dist/service.js");
  let lateAdd;
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  const entry = (name, setup) => ({ service: { name, kind: "plugin", setup }, status: "installed" });
  await assert.rejects(
    activateServiceRegistry(
      [entry("@setup/stuck", async ({ addService }) => {
        await resumed;
        try { addService({ name: "@setup/late", routes: [] }); lateAdd = "added"; }
        catch (error) { lateAdd = error.message; }
      })],
      {},
      { setupTimeoutMs: 50 },
    ),
    (error) => error instanceof ZelavisPluginAdmissionError && /"@setup\/stuck" setup did not finish within 50 ms/.test(error.message),
  );
  resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(lateAdd, /can no longer add services/);

  const fast = await activateServiceRegistry(
    [entry("@setup/fast", async ({ addService }) => { addService({ name: "@setup/child", routes: [] }); })],
    {},
    { setupTimeoutMs: 1_000 },
  );
  assert.deepEqual(fast.services.map((service) => service.name), ["@setup/child"]);
});
