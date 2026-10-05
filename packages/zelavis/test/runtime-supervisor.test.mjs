import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeRuntimeSupervisor } from "../dist/adapters/_node-runtime-supervisor.js";

const fixtureModule = fileURLToPath(new URL("./fixtures/handover-engine.mjs", import.meta.url));
const worker = fileURLToPath(new URL("../dist/adapters/_node-runtime-worker.js", import.meta.url));
const release = version => ({ version, digest: `sha256:${version}` });
const old = release("1.0.0"), next = release("2.0.0");
async function fixture(extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-handover-"));
  const backing = createLocalAgentProcessRunner();
  let stopFailed = false;
  const agent = !extra.retirementFailure && !extra.closeFailure ? backing : { ...backing,
    start: async (...args) => {
      const child = await backing.start(...args);
      const version = JSON.parse(args[0].env.ZELAVIS_RUNTIME_ENGINE_CONFIGURATION).version;
      return new Proxy(child, { get(target, name) {
        if (name !== "stop") return Reflect.get(target, name);
        return (...stopArgs) => {
          if (!stopFailed && (extra.closeFailure || extra.retirementFailure && version === old.version)) {
            stopFailed = true; return Promise.reject(new Error("injected retirement failure"));
          }
          return target.stop(...stopArgs);
        };
      } });
    },
  };
  const checkpoints = [], commits = [], logs = [];
  const supervisor = await Effect.runPromise(createNodeRuntimeSupervisor({
    agent, workloadId: "fixture", initial: old, generation: 1, startupTimeoutMs: 5000, drainTimeoutMs: extra.drainTimeoutMs ?? 1000,
    resolve: selected => Effect.succeed({ executable: process.execPath, worker, module: fixtureModule, cwd: directory, environment: {},
      configuration: { directory, version: selected.version, ...(selected.version === next.version ? extra : {}) } }),
    checkpoint: value => Effect.sync(() => { checkpoints.push(value); }),
    commit: (value, generation) => Effect.sync(() => { commits.push({ ...value, generation }); }),
    output: (stream, line) => logs.push({ stream, line }),
  }));
  const port = await Effect.runPromise(supervisor.listen({ host: "127.0.0.1", port: 0 }));
  return { directory, supervisor, port, checkpoints, commits, logs,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      // Release fixture-only held requests even when an assertion fails before
      // the test reaches its normal release, so teardown can report that failure.
      await writeFile(join(directory, "finish"), "yes");
      await Effect.runPromise(supervisor.close);
      await agent.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not become true.");
}

test("real child engines hand over a persistent port without dropping a request or overlapping SQLite owners", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(await (await fetch(f.url)).text(), old.version);
    const slow = fetch(`${f.url}/hold`);
    await until(() => f.supervisor.admission.snapshot().active === 1);
    const update = Effect.runPromise(f.supervisor.replace(next));
    await until(() => f.supervisor.admission.snapshot().paused);
    const queued = fetch(`${f.url}/write`, { method: "POST" });
    await until(() => f.supervisor.admission.snapshot().waiting === 1);
    assert.equal(f.supervisor.server.address().port, f.port);
    await writeFile(join(f.directory, "finish"), "yes");
    assert.equal(await (await slow).text(), old.version);
    assert.equal((await update).release.version, next.version);
    assert.equal(await (await queued).text(), "1");
    assert.equal(await (await fetch(f.url)).text(), next.version);
    const events = await readFile(join(f.directory, "events"), "utf8");
    assert.ok(events.indexOf("2.0.0:prepared") < events.indexOf("1.0.0:released"));
    assert.ok(events.indexOf("1.0.0:released") < events.indexOf("2.0.0:owned"));
    const data = new DatabaseSync(join(f.directory, "data.sqlite"));
    assert.deepEqual(data.prepare("SELECT value FROM writes").all().map(row => row.value), [next.version]); data.close();
  } finally { await f.close(); }
});

for (const kind of ["prepareFailure", "activationFailure"]) test(`real ${kind} leaves previous engine serving with the same listener`, { timeout: 15_000 }, async () => {
  const f = await fixture({ [kind]: true });
  try {
    await assert.rejects(Effect.runPromise(f.supervisor.replace(next)));
    assert.equal(await (await fetch(f.url)).text(), old.version);
    assert.equal(f.supervisor.server.address().port, f.port);
    assert.equal(f.supervisor.admission.snapshot().paused, false);
    assert.equal(f.supervisor.snapshot().requiresRecovery, false);
    const count = await (await fetch(`${f.url}/write`)).text(); assert.equal(count, "1");
  } finally { await f.close(); }
});

test("a long request that cannot drain aborts replacement and still completes on its original engine", { timeout: 15_000 }, async () => {
  const f = await fixture({ drainTimeoutMs: 30 });
  try {
    const slow = fetch(`${f.url}/hold`);
    await until(() => f.supervisor.admission.snapshot().active === 1);
    await assert.rejects(Effect.runPromise(f.supervisor.replace(next)), error => error._tag === "RuntimeDrainTimeout");
    assert.equal(await (await fetch(f.url)).text(), old.version);
    await writeFile(join(f.directory, "finish"), "yes");
    assert.equal(await (await slow).text(), old.version);
  } finally { await f.close(); }
});

test("bodies and headers stream through ingress with no control-plane authority added", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const body = "x".repeat(2 * 1024 * 1024);
    assert.equal(await (await fetch(`${f.url}/echo`, { method: "POST", body })).text(), body);
  } finally { await f.close(); }
});

test("concurrent replacements serialize candidate retirement, and close is idempotent", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const third = release("3.0.0");
    const results = await Promise.all([Effect.runPromise(f.supervisor.replace(next)), Effect.runPromise(f.supervisor.replace(third))]);
    assert.deepEqual(results.map(result => result.generation), [2, 3]);
    assert.equal(await (await fetch(f.url)).text(), third.version);
    await Effect.runPromise(f.supervisor.close);
    await Effect.runPromise(f.supervisor.close);
    await assert.rejects(Effect.runPromise(f.supervisor.replace(old)), /closed/);
  } finally { await f.close(); }
});

test("an accepted response stream survives an aborted update and delivers its remaining bytes", { timeout: 15_000 }, async () => {
  const f = await fixture({ drainTimeoutMs: 30 });
  try {
    const response = await fetch(`${f.url}/stream`), reader = response.body.getReader();
    assert.equal(response.status, 200);
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    await assert.rejects(Effect.runPromise(f.supervisor.replace(next)), error => error._tag === "RuntimeDrainTimeout");
    await writeFile(join(f.directory, "finish"), "yes");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "last\n");
    assert.equal((await reader.read()).done, true);
    assert.equal(await (await fetch(f.url)).text(), old.version);
  } finally { await f.close(); }
});

test("failure to retire an already released engine is visible cleanup debt and can be retried", { timeout: 15_000 }, async () => {
  const f = await fixture({ retirementFailure: true });
  try {
    const replaced = await Effect.runPromise(f.supervisor.replace(next));
    assert.equal(replaced.release.version, next.version);
    assert.deepEqual(replaced.cleanupFailures, ["injected retirement failure"]);
    assert.equal(await (await fetch(f.url)).text(), next.version);
    assert.equal(f.supervisor.snapshot().requiresRecovery, false);
    const retried = await Effect.runPromise(f.supervisor.replace(next));
    assert.deepEqual(retried.cleanupFailures, []);
    assert.equal(retried.generation, replaced.generation);
  } finally { await f.close(); }
});

test("a failed shutdown remains retryable and refuses further replacements", { timeout: 15_000 }, async () => {
  const f = await fixture({ closeFailure: true });
  try {
    await assert.rejects(Effect.runPromise(f.supervisor.close), /injected retirement failure/);
    assert.equal(f.supervisor.snapshot().owner.process.running, true);
    await assert.rejects(Effect.runPromise(f.supervisor.replace(next)), /shutting down/);
    await Effect.runPromise(f.supervisor.close);
    assert.equal(f.supervisor.snapshot().owner.process.running, false);
  } finally { await f.close(); }
});

test("an unexpected selected engine exit pauses admission and wakes its supervising host", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    await f.supervisor.snapshot().owner.process.signal("SIGKILL");
    await assert.rejects(Effect.runPromise(f.supervisor.failure), /exited/);
    assert.equal(f.supervisor.admission.snapshot().paused, true);
  } finally { await f.close(); }
});
