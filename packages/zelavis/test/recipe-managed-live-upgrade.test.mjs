// The managed path: a Project created from one version of a recipe, running, is upgraded through the
// Project manager to the next version while serving traffic, and the Platform restarts afterwards
// on what was committed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { entry, sleep, sourcesIn } from "./fixtures/managed-live.mjs";


async function fixture(t, rejectTarget, sourceOptions) {
  const base = await mkdtemp(join(tmpdir(), "zv-managed-live-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sources = await sourcesIn(base, sourceOptions);
  const projects = join(base, "projects");
  const memory = createMemorySystemStore();
  // The Platform's registry can be made to refuse the commit of the new recipe.
  const store = new Proxy(memory, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => {
      const record = args.find((argument) => argument && typeof argument === "object" && "recipe" in argument);
      const committing = record?.recipe?.version === "2.0.0" && record.runtimeUpdate && !record.runtimeUpdate.error;
      if (rejectTarget.on && committing) throw new Error("registry rejected the commit");
      return value.apply(target, args);
    };
  } });
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
  const runtime = createLocalProjectRuntime({
    directory: projects, agent,
    recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/live" ? sources[version ?? "1.0.0"] : undefined },
  });
  t.after(async () => { await runtime.close().catch(() => undefined); await agent.close(); });
  const managerFor = (version) => createProjectManager({ store, projectRecipes: [entry(version)], runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: ["node"] }) });
  return { projects, store, runtime, managerFor };
}

const web = (projects) => {
  const state = JSON.parse(readFileSync(join(projects, "live", ".zelavis", "recipe-state.json"), "utf8"));
  return (name) => fetch(`http://127.0.0.1:${state.ports[name]}/`).then((response) => response.json());
};
const descriptor = (projects) => JSON.parse(readFileSync(join(projects, "live", "project.json"), "utf8"));

test("a running managed Project upgrades its integration and its processes in one transaction, and nothing stops", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { on: false });
  const created = await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  assert.equal(created.runtime.status, "running");
  const ask = web(f.projects);
  const before = { web: await ask("web"), db: await ask("db") };
  assert.equal(before.web.config, "from version one");

  const manager = await f.managerFor("2.0.0");
  assert.equal((await manager.get("live")).recipeStatus.state, "upgradeAvailable");
  let stop = false, failures = 0, served = 0;
  const traffic = (async () => { while (!stop) { try { await ask("web"); served += 1; } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  const upgraded = await manager.upgrade("live", {});
  await sleep(100);
  stop = true; await traffic;

  assert.equal(failures, 0, "not one request failed");
  assert.ok(served > 30);
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "running");
  assert.equal(upgraded.runtimeUpdate, undefined);
  const after = { web: await ask("web"), db: await ask("db") };
  assert.deepEqual([after.web.pid, after.db.pid], [before.web.pid, before.db.pid], "the app's processes were not restarted");
  assert.equal(after.web.config, "from version two", "the processes follow the new recipe's configuration");
  assert.equal(descriptor(f.projects).recipe.version, "2.0.0", "the integration host's descriptor is the new recipe");
  assert.equal(descriptor(f.projects).recipe.managed.adminTitle, "Live admin 2.0.0");
  assert.equal(upgraded.recipe.artifact.digest, await digestArtifactDirectory(join(f.projects, "live", ".zelavis", "recipe", "package")));
  assert.equal(existsSync(join(f.projects, "live", ".zelavis", "upgrade")), false, "the workload's journal is gone");
  await manager.close();
});

test("when the registry refuses the commit, the processes, their configuration and the integration all return to the previous recipe", { timeout: 90_000 }, async (t) => {
  const rejecting = { on: false };
  const f = await fixture(t, rejecting);
  await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  const ask = web(f.projects);
  const before = { web: await ask("web"), db: await ask("db") };

  const manager = await f.managerFor("2.0.0");
  rejecting.on = true;
  let failures = 0, stop = false; const seen = new Set();
  const traffic = (async () => { while (!stop) { try { seen.add((await ask("web")).config); } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  await assert.rejects(manager.upgrade("live", {}), /registry rejected/);
  rejecting.on = false;
  await sleep(100);
  stop = true; await traffic;

  const project = await manager.get("live");
  assert.equal(project.recipe.version, "1.0.0");
  assert.equal(project.runtime.status, "running");
  assert.equal(project.runtimeUpdate, undefined, "the failed update was recovered, not left pending");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.equal(after.web.config, "from version one", "the configuration was put back and the process reloaded it");
  assert.equal(after.db.pid, before.db.pid);
  assert.equal(descriptor(f.projects).recipe.version, "1.0.0");
  assert.equal(existsSync(join(f.projects, "live", ".zelavis", "upgrade")), false);
  assert.equal(failures, 0, "the rolled-back upgrade also served every request");
  assert.ok(seen.has("from version two"), "the new configuration really was live before the commit was refused");
  await manager.close();
});

test("a managed Project upgraded while stopped prepares the app for the new recipe when it next starts", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { on: false });
  const first = await f.managerFor("1.0.0");
  await first.create({ name: "Live", id: "live", recipeName: "@acme/live" });
  await first.stop("live");
  const manager = await f.managerFor("2.0.0");
  const upgraded = await manager.upgrade("live", {});
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "stopped");
  const started = await manager.start("live");
  assert.equal(started.runtime.status, "running");
  assert.equal((await web(f.projects)("web")).config, "from version two", "install ran for the new recipe before the app started");
  assert.equal(JSON.parse(readFileSync(join(f.projects, "live", ".zelavis", "recipe-state.json"), "utf8")).installedFor, started.recipe.artifact.digest);
  assert.match((await web(f.projects)("db")).dir, /data-two$/, "the data moved to where the new recipe names it");
  assert.equal(readFileSync(join(f.projects, "live", "app", "data-two", "marker"), "utf8"), "the application's data");
  assert.equal(existsSync(join(f.projects, "live", "app", "data-one")), false);
  await manager.close();
});

test("a recipe that names another place for the data upgrades a running Project without touching the data, and the move happens the next time it starts from a stop", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { on: false });
  await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  const ask = web(f.projects);
  const before = await ask("db");
  assert.match(before.dir, /data-one$/);

  const manager = await f.managerFor("2.0.0");
  const upgraded = await manager.upgrade("live", {});
  assert.equal(upgraded.recipe.version, "2.0.0");
  const during = await ask("db");
  assert.equal(during.pid, before.pid, "the database was not restarted");
  assert.match(during.dir, /data-one$/, "its data was not moved under it");
  assert.equal(existsSync(join(f.projects, "live", "app", "data-two")), false);

  await manager.stop("live");
  const started = await manager.start("live");
  assert.equal(started.runtime.status, "running");
  const after = await ask("db");
  assert.match(after.dir, /data-two$/, "the next start moved the data to where the recipe names it");
  assert.equal(readFileSync(join(f.projects, "live", "app", "data-two", "marker"), "utf8"), "the application's data", "and nothing in it changed");
  assert.equal(existsSync(join(f.projects, "live", "app", "data-one")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.projects, "live", ".zelavis", "recipe-state.json"), "utf8")).layout, { data: "data-two" });
  await manager.close();
});

test("replacing the process that serves requests holds public requests at the ingress instead of failing them", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { on: false }, { replaceWeb: true });
  await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  const ask = web(f.projects);
  const before = { web: await ask("web"), db: await ask("db") };

  const manager = await f.managerFor("2.0.0");
  let stop = false; const direct = { failed: 0, served: 0 }, gated = { failed: 0, served: 0 };
  // Straight to the process, as nothing in front of it would.
  const bare = (async () => { while (!stop) { try { await ask("web"); direct.served += 1; } catch { direct.failed += 1; } await sleep(2); } })();
  // Through the Platform's ingress, which waits while the serving process is replaced.
  const through = (async () => { while (!stop) { try { await manager.ingressReady("live"); await ask("web"); gated.served += 1; } catch { gated.failed += 1; } await sleep(2); } })();
  await sleep(150);
  const upgraded = await manager.upgrade("live", {});
  await sleep(150);
  stop = true; await Promise.all([bare, through]);

  assert.equal(upgraded.recipe.version, "2.0.0");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.notEqual(after.web.pid, before.web.pid, "the web process really was replaced");
  assert.equal(after.db.pid, before.db.pid, "and the database was not");
  assert.ok(direct.failed > 0, "without the gate the replacement shows as failed requests");
  assert.equal(gated.failed, 0, "with it, not one request failed");
  assert.ok(gated.served > 20, `served ${gated.served}`);
  await manager.close();
});

// A real crash: the Platform that is upgrading a running Project is a separate process, killed (SIGKILL)
// while the commit is in flight. Whatever it left behind must settle onto one recipe.
for (const hang of ["before", "after"]) {
  test(`a Platform killed ${hang === "before" ? "before" : "right after"} the registry commit comes back with processes, configuration, integration and registry on one recipe`, { timeout: 180_000 }, async (t) => {
    const base = await mkdtemp(join(tmpdir(), "zv-managed-crash-"));
    const projects = join(base, "projects");
    const sources = await sourcesIn(base);
    const platform = (version) => {
      const store = createLocalSqliteSystemStore({ filename: join(base, "registry.sqlite") });
      const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
      const runtime = createLocalProjectRuntime({ directory: projects, agent,
        recipeRuntimes: { trusted: () => true, packageDirectory: (name, v) => name === "@acme/live" ? sources[v ?? "1.0.0"] : undefined } });
      const manager = createProjectManager({ store, projectRecipes: [entry(version)], runtime, autoReconcile: false,
        installHost: async () => ({ drivers: ["js"], requirements: ["node"] }) });
      const close = async () => { await (await manager).close().catch(() => undefined); await runtime.close().catch(() => undefined); await agent.close(); await store.close(); };
      return { store, agent, runtime, manager, close };
    };
    // Whatever survives the killed Platform must not outlive the test.
    t.after(() => {
      try {
        const { ports } = JSON.parse(readFileSync(join(projects, "live", ".zelavis", "recipe-state.json"), "utf8"));
        for (const port of Object.values(ports)) {
          try { for (const pid of execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) process.kill(Number(pid), "SIGKILL"); } catch { /* nothing listens */ }
        }
      } catch { /* never created */ }
      return rm(base, { recursive: true, force: true });
    });

    const first = platform("1.0.0");
    await (await first.manager).create({ name: "Live", id: "live", recipeName: "@acme/live" });
    await first.close();

    const child = spawn(process.execPath, [new URL("./fixtures/managed-live-crash.mjs", import.meta.url).pathname, JSON.stringify({ base, hang })], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    for (let i = 0; i < 1200 && !output.includes("HANGING"); i++) await sleep(50);
    assert.ok(output.includes("HANGING"), `the upgrade reached the commit: ${output}`);
    child.kill("SIGKILL");
    await exited;
    assert.ok(existsSync(join(projects, "live", ".zelavis", "upgrade")), "the killed Platform left its upgrade journal");

    // The Project host that outlived its Platform waits for the commit it was promised, and rolls back when
    // the deadline (15 s) passes. A Platform that starts sooner is told to retry; this one starts after.
    await sleep(17_000);
    const next = platform("2.0.0");
    t.after(() => next.close());
    await next.runtime.adopt();
    const manager = await next.manager;
    await manager.reconcile();
    let project = await manager.get("live");
    assert.equal(project.runtimeUpdate, undefined, `the unfinished update was settled: ${project.runtimeUpdate?.error}`);
    if (project.runtime.status !== "running") project = await manager.start("live");
    assert.equal(project.runtime.status, "running");
    const version = project.recipe.version;
    assert.ok(["1.0.0", "2.0.0"].includes(version));
    const config = version === "2.0.0" ? "from version two" : "from version one";
    assert.equal((await web(projects)("web")).config, config, "the processes run the recipe the registry names");
    assert.equal(descriptor(projects).recipe.version, version, "the integration host's descriptor names the same recipe");
    assert.equal(descriptor(projects).recipe.artifact.digest, await digestArtifactDirectory(join(projects, "live", ".zelavis", "recipe", "package")), "the descriptor and the frozen recipe agree");
    assert.equal(existsSync(join(projects, "live", ".zelavis", "upgrade")), false, "no half-finished workspace is left");
  });
}
