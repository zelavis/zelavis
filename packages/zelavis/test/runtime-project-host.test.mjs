import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeRuntimeClient } from "../dist/adapters/_node-runtime-client.js";
import { freezeNodeProjectRelease } from "../dist/adapters/_node-project-release.js";
import { digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";
import { createGatewayAuthoritySecret, createGatewayAuthorityNonce, signGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../dist/platform/gateway-authority.js";
import { acquireNodeRuntimeOwnership, proveNodeRuntimeUnowned } from "../dist/adapters/_node-runtime-ownership.js";
import { createNodeRuntimeJournal } from "../dist/adapters/_node-runtime-journal.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { createDeploymentBackendProjectRuntime } from "../dist/backends/registry.js";

test("the ordinary App runner keeps its listener and Gateway replay protection through a real engine handover", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-project-host-"));
  const backing = createLocalAgentProcessRunner();
  let control;
  const output = [];
  const agent = { ...backing, start: async (command, options) => {
    const child = await backing.start(command, { ...options, onOutput: event => {
      options.onOutput?.(event);
      if (event.stream === "stdout") control?.accept(event.line);
      output.push(event);
    } });
    control = createNodeRuntimeClient(child, 10_000);
    return child;
  } };
  const driver = createNodeProcessProjectRuntime({ directory, agent });
  try {
    const manifest = JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8"));
    const recipe = { name: manifest.name, version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"] };
    const project = { id: "one", name: "One", kind: "zelavis", runtimeKind: "native", recipe };
    await driver.prepare(project, recipe);
    const started = await driver.start(project);
    const path = `${started.url}/zelavis/api/v1/runtime/access`;
    const claims = { projectId: "one", scopeId: "platform", generation: 1, runtimeNodeId: "local", subject: "member", subjectType: "user", tenantId: "tenant", permissions: [] };
    const headers = async () => ({ [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await driver.signGatewayAuthority("one", claims) });
    const captured = await headers();
    const initial = await fetch(path, { headers: captured });
    assert.equal(initial.status, 200); await initial.text();
    const root = join(directory, "one"), file = join(root, "project.json");
    const descriptor = JSON.parse(await readFile(file, "utf8"));
    const packageFile = join(root, ".zelavis", "recipe", "package", "package.json");
    const candidate = JSON.parse(await readFile(packageFile, "utf8"));
    candidate.version = "1.0.2-host-test";
    await writeFile(packageFile, JSON.stringify(candidate));
    descriptor.recipe.version = candidate.version;
    descriptor.recipe.artifact.digest = await digestArtifactDirectory(join(packageFile, ".."));
    await writeFile(file, JSON.stringify(descriptor));
    const selected = await Effect.runPromise(freezeNodeProjectRelease(root));
    await Promise.all([Effect.runPromise(control.request({ action: "replace", release: selected })).then(value => assert.equal(value.type, "replaced")),
      ...Array.from({ length: 30 }, async () => {
        const response = await fetch(path, { headers: await headers() });
        assert.equal(response.status, 200, JSON.stringify(output)); await response.text();
      })]);
    assert.equal((await driver.status("one")).url, started.url);
    const replay = await fetch(path, { headers: captured });
    assert.equal(replay.status, 401); await replay.text();
    const config = await (await fetch(`${started.url}/zelavis/api/v1/runtime/config`, { headers: await headers() })).json();
    assert.equal(config.serviceRegistry.find(entry => entry.name === manifest.name).version, candidate.version);
    const bad = { ...selected, digest: `sha256:${"f".repeat(64)}` };
    await assert.rejects(Effect.runPromise(control.request({ action: "replace", release: bad })));
    const healthy = await fetch(path, { headers: await headers() });
    assert.equal(healthy.status, 200); await healthy.text();
    const nextSecret = createGatewayAuthoritySecret();
    assert.equal((await Effect.runPromise(control.request({ action: "rotate-key", secret: nextSecret }))).type, "key-rotated");
    const previousKey = await fetch(path, { headers: await headers() });
    assert.equal(previousKey.status, 401); await previousKey.text();
    const next = await signGatewayAuthority(nextSecret, { ...claims, nonce: createGatewayAuthorityNonce(), expiresAt: Date.now() + 30_000 });
    const authorized = await fetch(path, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: next } });
    assert.equal(authorized.status, 200); await authorized.text();
    await driver.stop("one");
    await Effect.runPromise(proveNodeRuntimeUnowned(join(root, ".zelavis")));
  } finally { await driver.close(); await backing.close(); await rm(directory, { recursive: true, force: true }); }
});

test("kernel ownership refuses concurrent workers and recovery cannot overwrite a selection while an owner lives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-runtime-owner-"));
  let release;
  const old = { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }, next = { version: "2.0.0", digest: `sha256:${"b".repeat(64)}` };
  const file = join(directory, "handover.json");
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      yield* journal.recover(old, proveNodeRuntimeUnowned(directory));
    })));
    release = await Effect.runPromise(acquireNodeRuntimeOwnership(directory));
    await assert.rejects(Effect.runPromise(acquireNodeRuntimeOwnership(directory)), /locked/);
    const bytes = await readFile(file, "utf8");
    await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      yield* journal.recover(next, proveNodeRuntimeUnowned(directory), "authorized-initial");
    }))), /locked/);
    assert.equal(await readFile(file, "utf8"), bytes);
    await Effect.runPromise(release); release = undefined;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      assert.deepEqual(yield* journal.recover(next, proveNodeRuntimeUnowned(directory), "authorized-initial"), { release: next, generation: 2 });
    })));
  } finally { if (release) await Effect.runPromise(release); await rm(directory, { recursive: true, force: true }); }
});

for (const failedCommit of [false, true]) test(`the Platform Project lifecycle ${failedCommit ? "rolls back a failed lock commit" : "upgrades a running App"} through both driver routers`, { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-live-project-lifecycle-"));
  const versions = new Map();
  let manager;
  try {
    for (const version of ["1.0.0", "2.0.0"]) {
      const path = join(directory, "recipes", version);
      await mkdir(join(path, "dist"), { recursive: true });
      await writeFile(join(path, "package.json"), JSON.stringify({ name: "acme/app", version, type: "module", exports: "./dist/index.js", files: ["dist"],
        zelavis: { namespace: "testapp", kind: "app", project: { runtimeKinds: ["native"] } } }));
      await writeFile(join(path, "dist", "index.js"), "export function register() {}\n");
      versions.set(version, path);
    }
    const store = createMemorySystemStore();
    const events = [];
    let injected = false;
    const guardedStore = !failedCommit ? store : { ...store, set: async (namespace, id, value) => {
      if (!injected && namespace === "projects" && value.recipe?.version === "2.0.0" && value.runtimeUpdate) {
        injected = true; throw new Error("injected Project lock commit failure");
      }
      return store.set(namespace, id, value);
    } };
    const local = createLocalProjectRuntime({ directory: join(directory, "projects"), recipePackageDirectory: (_name, version) => versions.get(version) });
    const runtime = createDeploymentBackendProjectRuntime({ store: guardedStore, backends: [{ id: "native", projectRuntime: local }] });
    const entry = { service: { name: "acme/app", kind: "app", version: "1.0.0", project: { runtimeKinds: ["native"] } },
      specifier: "acme/app", status: "available", source: "community" };
    manager = await createProjectManager({ store: guardedStore, runtime, projectRecipes: [entry] });
    const initial = await manager.create({ id: "one", name: "One", recipeName: "acme/app", start: true });
    assert.equal(initial.runtime.status, "running");
    assert.equal(initial.capabilities.zeroDowntimeUpdates, true);
    entry.service.version = "2.0.0";
    const claims = { projectId: "one", scopeId: "platform", generation: 1, runtimeNodeId: "local", subject: "member", subjectType: "user", tenantId: "tenant", permissions: [] };
    const request = async () => {
      const authority = await manager.signGatewayAuthority("one", claims);
      const response = await fetch(`${initial.runtime.url}/zelavis/api/v1/runtime/access`, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: authority } });
      events.push(response.status); await response.text();
    };
    const traffic = Promise.all(Array.from({ length: 40 }, request));
    if (failedCommit) await assert.rejects(manager.upgrade("one"), /injected Project lock commit failure/);
    else assert.equal((await manager.upgrade("one")).runtime.status, "running");
    await traffic;
    assert.ok(events.every(status => status === 200));
    const selected = await manager.get("one");
    assert.equal(selected.recipe.version, failedCommit ? "1.0.0" : "2.0.0");
    assert.equal(selected.runtime.url, initial.runtime.url);
    assert.equal(selected.runtimeUpdate, undefined);
    const descriptor = JSON.parse(await readFile(join(directory, "projects", "one", "project.json"), "utf8"));
    assert.equal(descriptor.recipe.version, selected.recipe.version);
    assert.equal(selected.recipeHistory?.length ?? 0, failedCommit ? 0 : 1);
    await request();
    if (!failedCommit) {
      // Simulate losing the Platform reply after the host durably selected its
      // candidate. Reconciliation settles the persisted intent from host proof.
      const current = await store.get("projects", "one");
      const release = JSON.parse(await readFile(join(directory, "projects", "one", ".zelavis", "runtime-handover.json"), "utf8")).selected;
      const pending = { id: "lost-reply", startedAt: new Date().toISOString(),
        execution: { mode: "engine", previous: { ...release, digest: `sha256:${"a".repeat(64)}` }, target: release, recipe: selected.recipe },
        previous: { kind: initial.kind, recipe: initial.recipe, recipeHistory: [] },
        target: { kind: selected.kind, recipe: selected.recipe, recipeHistory: selected.recipeHistory } };
      await store.set("projects", "one", { ...current.value, recipe: initial.recipe, runtimeUpdate: pending });
      await manager.reconcile();
      const recovered = await manager.get("one");
      assert.equal(recovered.recipe.version, "2.0.0");
      assert.equal(recovered.runtimeUpdate, undefined);
      assert.equal(recovered.runtime.url, initial.runtime.url);
    }
  } finally { await manager?.close(); await rm(directory, { recursive: true, force: true }); }
});
