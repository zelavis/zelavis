import assert from "node:assert/strict";
import test from "node:test";

import {
  ZelavisProjectIsolationError,
  assessProjectIsolation,
  createMemorySystemStore,
  createProjectManager,
  normalizeProjectIsolationIntent,
} from "../dist/index.js";

const PROCESS_BACKEND = Object.freeze({
  isolationBoundary: "process",
  filesystemIsolation: "planned",
  processIsolation: "planned",
  networkIsolation: "planned",
  resourceControls: { cpu: "planned", memory: "planned", pids: "planned", disk: "planned" },
  exec: "available",
  persistentStorage: "available",
  snapshots: "planned",
  images: "unavailable",
  description: "process backend",
});

const MICROVM_BACKEND = Object.freeze({
  ...PROCESS_BACKEND,
  isolationBoundary: "microvm",
  filesystemIsolation: "available",
  processIsolation: "available",
  networkIsolation: "available",
  resourceControls: { cpu: "available", memory: "available", pids: "available", disk: "available" },
  description: "microvm backend",
});

test("isolation intent refuses unknown or malformed requirements", () => {
  assert.equal(normalizeProjectIsolationIntent(undefined), undefined);
  assert.equal(normalizeProjectIsolationIntent({}), undefined);
  assert.deepEqual(
    normalizeProjectIsolationIntent({
      boundary: { minimum: "microvm", enforcement: "required" },
      network: "advisory",
    }),
    { boundary: { minimum: "microvm", enforcement: "required" }, network: "advisory" },
  );
  // A misspelt requirement must not silently vanish.
  assert.throws(() => normalizeProjectIsolationIntent({ netwrok: "required" }), /Unknown/);
  assert.throws(() => normalizeProjectIsolationIntent({ network: "strict" }), /required" or "advisory/);
  assert.throws(() => normalizeProjectIsolationIntent({ boundary: { minimum: "vm", enforcement: "required" } }), /boundary/);
  assert.throws(() => normalizeProjectIsolationIntent({ boundary: { minimum: "microvm" } }), /boundary/);
  assert.throws(() => normalizeProjectIsolationIntent({ boundary: { minimum: "microvm", enforcement: "required", extra: 1 } }), /boundary/);
  assert.throws(() => normalizeProjectIsolationIntent(["network"]), /object/);
});

test("assessment treats planned and undescribed capability as unmet", () => {
  const intent = {
    boundary: { minimum: "os-container", enforcement: "required" },
    network: "advisory",
  };
  const weak = assessProjectIsolation(intent, "native", PROCESS_BACKEND);
  assert.equal(weak.satisfied, false);
  assert.deepEqual(weak.shortfalls, [
    { requirement: "boundary", enforcement: "required", expected: "os-container", actual: "process" },
    { requirement: "network", enforcement: "advisory", expected: "available", actual: "planned" },
  ]);

  const strong = assessProjectIsolation(intent, "firecracker", MICROVM_BACKEND);
  assert.deepEqual(strong, { runtimeKind: "firecracker", satisfied: true, shortfalls: [] });

  // Advisory shortfalls never refuse.
  assert.equal(assessProjectIsolation({ network: "advisory" }, "native", PROCESS_BACKEND).satisfied, true);

  const unknown = assessProjectIsolation({ filesystem: "required" }, "native", undefined);
  assert.equal(unknown.satisfied, false);
  assert.equal(unknown.shortfalls[0].actual, "unknown");
});

function recipe(name, isolation) {
  return {
    service: {
      name,
      kind: "app",
      version: "1.0.0",
      project: { runtimeKinds: ["native"], ...(isolation ? { isolation } : {}) },
    },
    specifier: name,
    status: "installed",
    source: "official",
  };
}

function testRuntime(calls) {
  return {
    name: "test-runtime",
    runtimeKinds: ["native"],
    capabilities: () => ({ statelessRuntimeReplicas: false }),
    async prepare(project) { calls.push(`prepare:${project.id}`); },
    async start(project) {
      calls.push(`start:${project.id}`);
      return { status: "running", url: "http://127.0.0.1:1" };
    },
    async stop(projectId) {
      calls.push(`stop:${projectId}`);
      return { status: "stopped" };
    },
    async status() { return { status: "stopped" }; },
    async logs() { return []; },
    async destroy() {},
    async close() {},
  };
}

test("Project manager refuses required isolation it cannot prove and never provisions", async () => {
  const store = createMemorySystemStore();
  const calls = [];
  const manager = await createProjectManager({
    store,
    runtime: testRuntime(calls),
    projectRecipes: [
      recipe("acme/vm-only", { boundary: { minimum: "microvm", enforcement: "required" } }),
      recipe("acme/advised", { network: "advisory" }),
      recipe("acme/plain"),
    ],
    backendCapabilities: () => PROCESS_BACKEND,
    autoReconcile: false,
  });

  await assert.rejects(
    manager.create({ name: "vm", recipeName: "acme/vm-only" }),
    (error) => {
      assert.ok(error instanceof ZelavisProjectIsolationError);
      assert.equal(error.name, "ZelavisProjectIsolationError");
      assert.equal(error.assessment.runtimeKind, "native");
      assert.match(error.message, /boundary \(needs microvm, backend has process\)/);
      return true;
    },
  );
  assert.equal(await store.get("projects", "vm"), undefined);
  assert.deepEqual(calls, []);

  const advised = await manager.create({ name: "advised", recipeName: "acme/advised" });
  assert.equal(advised.runtime.status, "running");
  assert.deepEqual(advised.recipe.isolation, { network: "advisory" });
  assert.deepEqual(advised.isolation, {
    runtimeKind: "native",
    satisfied: true,
    shortfalls: [{ requirement: "network", enforcement: "advisory", expected: "available", actual: "planned" }],
  });

  const plain = await manager.create({ name: "plain", recipeName: "acme/plain", start: false });
  assert.equal(plain.isolation, undefined);
  assert.equal(plain.recipe.isolation, undefined);
});

test("a locked required intent refuses start and restart when capability no longer proves it", async () => {
  const store = createMemorySystemStore();
  const calls = [];
  let capabilities = MICROVM_BACKEND;
  const options = {
    store,
    runtime: testRuntime(calls),
    projectRecipes: [recipe("acme/vm-only", { boundary: { minimum: "microvm", enforcement: "required" } })],
    backendCapabilities: () => capabilities,
    autoReconcile: false,
  };
  const manager = await createProjectManager(options);
  const created = await manager.create({ name: "vm", recipeName: "acme/vm-only" });
  assert.equal(created.runtime.status, "running");
  assert.equal(created.isolation.satisfied, true);
  assert.deepEqual(
    (await store.get("projects", "vm")).value.recipe.isolation,
    { boundary: { minimum: "microvm", enforcement: "required" } },
  );

  // The backend stops proving the boundary. The lock keeps the intent; the
  // record reports the shortfall; nothing is stopped or started to find out.
  capabilities = PROCESS_BACKEND;
  calls.length = 0;
  const read = await manager.get("vm");
  assert.equal(read.isolation.satisfied, false);
  await assert.rejects(manager.restart("vm"), ZelavisProjectIsolationError);
  assert.deepEqual(calls, []);

  await manager.stop("vm");
  calls.length = 0;
  await assert.rejects(manager.start("vm"), ZelavisProjectIsolationError);
  assert.deepEqual(calls, []);
  // The refusal is written as a failure with its reason. A later read takes
  // live status from the driver, while `isolation` keeps reporting why.
  const failed = (await store.get("projects", "vm")).value;
  assert.equal(failed.runtime.status, "failed");
  assert.match(failed.runtime.error, /refuses rather than running it with weaker isolation/);
  assert.equal((await manager.get("vm")).isolation.satisfied, false);

  // Without any backend description, required intent is refused too.
  const undescribed = await createProjectManager({ ...options, backendCapabilities: undefined });
  await assert.rejects(undescribed.start("vm"), ZelavisProjectIsolationError);
});

test("a stored lock with malformed isolation intent is refused, not dropped", async () => {
  const store = createMemorySystemStore();
  await store.set("projects", "tampered", {
    id: "tampered",
    name: "Tampered",
    kind: "vm-only",
    runtimeKind: "native",
    recipe: {
      name: "acme/vm-only",
      title: "VM",
      version: "1.0.0",
      specifier: "acme/vm-only",
      runtimeKinds: ["native"],
      isolation: { boundary: { minimum: "microvm", enforcement: "optional" } },
    },
    desiredState: "stopped",
    runtime: { driver: "test-runtime", status: "stopped" },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  });
  const manager = await createProjectManager({
    store,
    runtime: testRuntime([]),
    projectRecipes: [],
    backendCapabilities: () => MICROVM_BACKEND,
    autoReconcile: false,
  });
  await assert.rejects(manager.get("tampered"), /invalid isolation intent/);
});

test("package loading validates recipe isolation intent before any Project exists", async () => {
  const { loadPluginPackage } = await import("../dist/service.js");
  const manifest = (isolation) => ({
    name: "@acme/vm-recipe",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
    zelavis: {
      kind: "app",
      namespace: "vmRecipe",
      project: { runtimeKinds: ["native"], isolation },
    },
  });
  const loaded = await loadPluginPackage({
    manifest: manifest({ network: "required" }),
    importer: async () => ({}),
  });
  assert.deepEqual(loaded.project, { runtimeKinds: ["native"], isolation: { network: "required" } });
  await assert.rejects(
    loadPluginPackage({ manifest: manifest({ networking: "required" }), importer: async () => ({}) }),
    /invalid zelavis\.project\.isolation: Unknown Project isolation requirement "networking"/,
  );
});

test("resource limits are bounded quantities checked per backend control", () => {
  const intent = normalizeProjectIsolationIntent({
    resources: {
      memoryMiB: { limit: 512, enforcement: "required" },
      pids: { limit: 256, enforcement: "advisory" },
    },
  });
  assert.deepEqual(intent, {
    resources: {
      memoryMiB: { limit: 512, enforcement: "required" },
      pids: { limit: 256, enforcement: "advisory" },
    },
  });
  for (const bad of [
    { memory: { limit: 512, enforcement: "required" } },
    { memoryMiB: { limit: 1, enforcement: "required" } },
    { memoryMiB: { limit: 512.5, enforcement: "required" } },
    { memoryMiB: { limit: "512", enforcement: "required" } },
    { memoryMiB: { limit: 512 } },
    { memoryMiB: { limit: 512, enforcement: "required", request: 256 } },
  ]) {
    assert.throws(() => normalizeProjectIsolationIntent({ resources: bad }), /resource limit/);
  }
  assert.throws(() => normalizeProjectIsolationIntent({ resourceLimits: "required" }), /Unknown/);

  const partial = {
    ...PROCESS_BACKEND,
    resourceControls: { cpu: "available", memory: "available", pids: "planned", disk: "planned" },
  };
  const assessment = assessProjectIsolation(intent, "cgroup", partial);
  assert.equal(assessment.satisfied, true);
  assert.deepEqual(assessment.shortfalls, [
    { requirement: "resources.pids", enforcement: "advisory", expected: "available", actual: "planned" },
  ]);
  assert.equal(assessProjectIsolation(intent, "native", PROCESS_BACKEND).satisfied, false);
});

test("creation selects an enabled backend that satisfies required intent, never a weaker one", async () => {
  const store = createMemorySystemStore();
  const calls = [];
  const runtime = { ...testRuntime(calls), runtimeKinds: ["native", "docker", "firecracker"] };
  const capabilities = { native: PROCESS_BACKEND, docker: { ...PROCESS_BACKEND, isolationBoundary: "os-container" }, firecracker: MICROVM_BACKEND };
  let alternatives = ["docker", "firecracker"];
  const vmRecipe = recipe("acme/vm-only", { boundary: { minimum: "microvm", enforcement: "required" } });
  vmRecipe.service.project.runtimeKinds = ["native", "docker", "firecracker"];
  const containerRecipe = recipe("acme/container", { boundary: { minimum: "os-container", enforcement: "required" } });
  containerRecipe.service.project.runtimeKinds = ["native", "docker", "firecracker"];
  const advisedRecipe = recipe("acme/advised", { boundary: { minimum: "microvm", enforcement: "advisory" } });
  advisedRecipe.service.project.runtimeKinds = ["native", "docker", "firecracker"];
  const manager = await createProjectManager({
    store,
    runtime,
    projectRecipes: [vmRecipe, containerRecipe, advisedRecipe],
    resolveDefaultRuntimeKind: async () => "native",
    resolveAlternativeRuntimeKinds: async () => alternatives,
    backendCapabilities: (kind) => capabilities[kind],
    autoReconcile: false,
  });

  // First satisfying alternative in administrator order, not the strongest.
  assert.equal((await manager.create({ name: "container", recipeName: "acme/container", start: false })).runtimeKind, "docker");
  assert.equal((await manager.create({ name: "vm", recipeName: "acme/vm-only", start: false })).runtimeKind, "firecracker");
  // Advisory intent never moves a Project off the default.
  assert.equal((await manager.create({ name: "advised", recipeName: "acme/advised", start: false })).runtimeKind, "native");

  // Nothing enabled satisfies it: refused with the default's shortfall.
  alternatives = ["docker"];
  await assert.rejects(manager.create({ name: "vm2", recipeName: "acme/vm-only" }), (error) => {
    assert.ok(error instanceof ZelavisProjectIsolationError);
    assert.equal(error.assessment.runtimeKind, "native");
    return true;
  });
  assert.equal(await store.get("projects", "vm2"), undefined);

  // An existing Project keeps its assignment even when its backend stops
  // satisfying it and another would: start refuses rather than moving it.
  calls.length = 0;
  capabilities.firecracker = PROCESS_BACKEND;
  alternatives = ["docker", "firecracker"];
  capabilities.docker = MICROVM_BACKEND;
  await assert.rejects(manager.start("vm"), ZelavisProjectIsolationError);
  assert.equal((await manager.get("vm")).runtimeKind, "firecracker");
  assert.deepEqual(calls, []);
});
