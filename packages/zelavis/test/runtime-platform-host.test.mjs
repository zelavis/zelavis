import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Scope } from "effect";
import { createNodePlatformHost } from "../dist/adapters/_node-platform-host.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { selectNodeInstallationRuntime } from "../dist/adapters/_node-runtime-selection.js";
import { requestNodeRuntimeControl } from "../dist/adapters/_node-runtime-control.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

const old = { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const next = { version: "2.0.0", digest: `sha256:${"b".repeat(64)}` };
const bootstrapToken = "platform-host-ownership-first-owner-token";
const worker = fileURLToPath(new URL("../dist/adapters/_node-runtime-worker.js", import.meta.url));
const module = fileURLToPath(new URL("../dist/adapters/_node-platform-engine.js", import.meta.url));

test("ordinary Platform startup remains ready when a desired-running Project cannot be restored", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-platform-failed-"));
  const scope = Scope.makeUnsafe(), logs = [];
  try {
    const store = createLocalSqliteSystemStore({ filename: join(directory, "system", "zelavis.sqlite") });
    const now = new Date().toISOString();
    await store.set("projects", "broken", { id: "broken", name: "Broken", kind: "zelavis", runtimeKind: "native",
      recipe: { name: "@zelavis/app", title: "Zelavis App", version: "0.0.1", specifier: "@zelavis/app", runtimeKinds: ["native"] },
      desiredState: "running", runtime: { driver: "native", status: "running", url: "http://127.0.0.1:1" }, createdAt: now, updatedAt: now });
    await store.close();
    const host = await Effect.runPromise(createNodePlatformHost({ dataDirectory: directory, host: "127.0.0.1", initial: old,
      environment: { ZELAVIS_BOOTSTRAP_TOKEN: bootstrapToken }, startupTimeoutMs: 10_000,
      output: (stream, line) => logs.push({ stream, line }),
      resolve: (_release, configuration, environment) => Effect.succeed({ executable: process.execPath, worker, module, cwd: directory, configuration, environment }),
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const port = await Effect.runPromise(host.listen({ host: "127.0.0.1", port: 0 }));
    const anonymous = createZelavisClient({ baseUrl: `http://127.0.0.1:${port}` });
    const status = await anonymous.json("/auth/bootstrap");
    assert.equal(status.required, true, "dashboard bootstrap is available despite failed fleet restoration");
    assert.equal(host.snapshot().requiresRecovery, false);
  } catch (error) { console.error(JSON.stringify(logs)); throw error; }
  finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); }
});

for (const failedActivation of [false, true]) test(`Platform ${failedActivation ? "rollback" : "handover"} preserves the running App, Fabric custody and public preview socket`, { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-platform-host-"));
  const scope = Scope.makeUnsafe(), logs = [];
  try {
    const prefix = join(directory, "installation");
    for (const release of [old, next]) await mkdir(join(prefix, "releases", release.version), { recursive: true });
    await symlink(join(prefix, "releases", old.version), join(prefix, "current"));
    await writeFile(join(prefix, "installation.json"), JSON.stringify({ schemaVersion: 2, instance: "default", mode: "user", prefix, dataDirectory: directory, version: old.version }));
    await writeFile(join(prefix, "runtime.json"), JSON.stringify({ schemaVersion: 1, instance: "default", prefix, dataDirectory: directory, version: old.version }));
    const host = await Effect.runPromise(createNodePlatformHost({ dataDirectory: directory, host: "127.0.0.1", initial: old,
      select: version => Effect.succeed(version === old.version ? old : next),
      environment: { ZELAVIS_BOOTSTRAP_TOKEN: bootstrapToken }, startupTimeoutMs: 15_000,
      resolve: (release, configuration, environment) => Effect.succeed({ executable: process.execPath, worker,
        module: failedActivation && release.version === next.version ? fileURLToPath(new URL("./fixtures/handover-engine.mjs", import.meta.url)) : module,
        cwd: directory, configuration: failedActivation && release.version === next.version ? { ...configuration, directory, version: release.version, activationFailure: true } : configuration, environment }),
      output: (stream, line) => logs.push({ stream, line }),
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const port = await Effect.runPromise(host.listen({ host: "127.0.0.1", port: 0 }));
    const url = `http://127.0.0.1:${port}`;
    const anonymous = createZelavisClient({ baseUrl: url });
    await anonymous.json("/auth/bootstrap", { method: "POST", body: { bootstrapToken, provider: "password",
      account: { email: "owner@example.com" }, credential: { identifier: "owner@example.com", password: "correct horse battery staple" } } });
    const { session } = await anonymous.auth.signInWithPassword({ identifier: "owner@example.com", password: "correct horse battery staple" });
    const owner = createZelavisClient({ baseUrl: url, headers: { authorization: `Bearer ${session.token}` } });
    await owner.projects.create({ id: "one", name: "One", recipeName: "@zelavis/app", start: false });
    const frontend = join(directory, "projects", "one", ".zelavis", "services", "site");
    await mkdir(join(frontend, "dist"), { recursive: true });
    await writeFile(join(frontend, "package.json"), JSON.stringify({ name: "@test/site", version: "1.0.0", zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist" } } }));
    await writeFile(join(frontend, "dist", "index.html"), "<h1>Persistent App site</h1>");
    const app = await owner.projects.start("one");
    assert.equal(app.runtime.status, "running", JSON.stringify(logs));
    assert.equal(app.preview?.status, "ready", JSON.stringify(app));
    const preview = `http://127.0.0.1:${app.preview.port}`;
    const first = await fetch(preview); const body = await first.text();
    assert.equal(first.status, 200, body);
    const records = await readdir(join(directory, "projects", ".agent-processes"));
    const pids = await Promise.all(records.map(name => readFile(join(directory, "projects", ".agent-processes", name), "utf8").then(JSON.parse)));
    const appPid = pids.find(record => record.workloadId === "one")?.pid;
    assert.ok(appPid, JSON.stringify(pids));
    const traffic = Promise.all(Array.from({ length: 40 }, async () => {
      const response = await fetch(preview).catch(error => { throw new Error("PREVIEW TRAFFIC", { cause: error }); }); assert.equal(response.status, 200); assert.equal(await response.text(), body);
    }));
    const selection = selectNodeInstallationRuntime({ prefix, instance: "default", dataDirectory: directory, version: next.version });
    const [selected, served] = await Promise.allSettled([Effect.runPromise(selection), traffic]);
    assert.equal(served.status, "fulfilled", String(served.reason));
    if (failedActivation) { assert.equal(selected.status, "rejected"); assert.match(String(selected.reason.message), /Runtime handover failed/); }
    else assert.equal(selected.status, "fulfilled", String(selected.reason?.message));
    assert.equal(JSON.parse(await readFile(join(prefix, "installation.json"), "utf8")).version, failedActivation ? old.version : next.version);
    assert.equal(JSON.parse(await readFile(join(prefix, "runtime.json"), "utf8")).version, failedActivation ? old.version : next.version);
    await traffic;
    const after = await owner.projects.get("one").catch(error => { throw new Error("AFTER PROJECT READ", { cause: error }); });
    assert.equal(after.runtime.status, "running", JSON.stringify(logs));
    assert.equal(after.runtime.url, app.runtime.url);
    assert.equal(after.preview.port, app.preview.port);
    assert.equal((await owner.json("/runtime/access")).mode, "owner");
    process.kill(appPid, 0);
    const remaining = await readdir(join(directory, "projects", ".agent-processes"));
    const adopted = await Promise.all(remaining.map(name => readFile(join(directory, "projects", ".agent-processes", name), "utf8").then(JSON.parse)));
    assert.equal(adopted.find(record => record.workloadId === "one")?.pid, appPid);
    assert.equal((await Effect.runPromise(requestNodeRuntimeControl(host.endpoint, { action: "status" }))).release.version, failedActivation ? old.version : next.version);
    assert.equal((await fetch(`${url}/`, { headers: { "x-zelavis-runtime-preview": "one", "x-zelavis-runtime-preview-key": "forged" }, redirect: "manual" })).status, 307);
  } catch (error) { console.error(JSON.stringify(logs.filter(entry => entry.stream === "stderr"), null, 2)); throw error; } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(directory, { recursive: true, force: true });
  }
});
