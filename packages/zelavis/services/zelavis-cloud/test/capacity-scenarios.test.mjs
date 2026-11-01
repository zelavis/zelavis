// Alchemy's Hetzner.Server provider, driven headless against a fake Hetzner API.
// What these hold the design to: a retry after any crash neither duplicates nor
// orphans a machine, and release deletes only what Zelavis created.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startFakeHetzner } from "./fake-hetzner.mjs";
import { capacityStack, makeRunner, makeState, observeOrigins } from "./headless.mjs";
import { capacityNodeName } from "../dist/index.js";

async function harness(t) {
  const fake = await startFakeHetzner();
  const state = await makeState();
  const runner = makeRunner({ fake, state });
  t.after(() => fake.close());
  const creates = () => fake.log.filter((line) => line.startsWith("POST /servers")).length;
  const names = () => [...fake.servers.values()].map((server) => server.name).sort();
  return { fake, state, runner, creates, names };
}

test("create is idempotent: a second deploy changes nothing", async (t) => {
  const { fake, state, runner, creates } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state });
  const first = await runner.deploy(stack);
  const second = await runner.deploy(stack);
  assert.equal(first.id, second.id);
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1);
});

test("the machine is named from the request id and labeled as Zelavis-managed", async (t) => {
  const { fake, state, runner } = await harness(t);
  await runner.deploy(capacityStack({ requestId: "req-1", state }));
  const [server] = [...fake.servers.values()];
  assert.equal(server.name, capacityNodeName("req-1"));
  assert.equal(server.labels["zelavis.io/managed"], "true");
});

test("destroy removes the machine and its generated key", async (t) => {
  const { fake, state, runner } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state });
  await runner.deploy(stack);
  assert.equal(fake.sshKeys.size, 1);
  await runner.destroy(stack);
  assert.equal(fake.servers.size, 0);
  assert.equal(fake.sshKeys.size, 0);
});

test("destroy never deletes a machine Zelavis did not create", async (t) => {
  const { fake, state, runner, names } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state });
  await runner.deploy(stack);
  fake.servers.set(999, {
    id: 999, name: "someone-elses-server", server_type: "cpx11", image: "x",
    location: "nbg1", labels: {}, created: new Date().toISOString(),
  });
  await runner.destroy(stack);
  assert.deepEqual(names(), ["someone-elses-server"]);
});

test("a crash right after the cloud create is recovered by a retry", async (t) => {
  const { fake, state, runner, creates } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state });
  state.fault.failNextCreatedWrite = 1;
  await assert.rejects(() => runner.deploy(stack), /injected state write failure/);
  assert.equal(fake.servers.size, 1, "the cloud already has the machine");
  assert.equal(state.row("node")?.status, "creating", "the intent was recorded before the cloud call");
  await runner.deploy(stack);
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1, "the retry created nothing");
  assert.equal(state.row("node")?.status, "created");
});

test("a crash with the state lost entirely adopts the machine by its deterministic name", async (t) => {
  const { fake, state, runner, names } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state });
  state.fault.failNextCreatedWrite = 1;
  await assert.rejects(() => runner.deploy(stack));
  state.lose();
  assert.deepEqual(state.stored(), []);
  await runner.deploy(stack);
  assert.deepEqual(names(), [capacityNodeName("req-1")]);
  assert.equal(fake.sshKeys.size, 1, "no second deploy key");
});

test("a create that committed but whose response was lost does not duplicate", async (t) => {
  const { fake, state, runner, names } = await harness(t);
  fake.faults.dropResponseAfterCreate = 1;
  await runner.deploy(capacityStack({ requestId: "req-1", state }));
  assert.deepEqual(names(), [capacityNodeName("req-1")]);
  assert.equal(fake.sshKeys.size, 1);
});

test("Alchemy's default random names would orphan a machine when state is lost (why names are derived)", async (t) => {
  const { fake, state, runner } = await harness(t);
  const stack = capacityStack({ requestId: "req-1", state, deterministic: false });
  state.fault.failNextCreatedWrite = 1;
  await assert.rejects(() => runner.deploy(stack));
  state.lose();
  await runner.deploy(stack);
  assert.equal(fake.servers.size, 2, "documents the failure the deterministic name prevents");
});

test("the network observer sees a request to an unexpected host (control for the guard below)", async (t) => {
  const stray = http.createServer((request, response) => response.end("ok")).listen(0, "127.0.0.1");
  await new Promise((resolve) => stray.on("listening", resolve));
  t.after(() => stray.close());
  const origins = observeOrigins(t);
  await (await fetch(`http://127.0.0.1:${stray.address().port}/`)).text();
  assert.ok(origins.has(`127.0.0.1:${stray.address().port}`));
});

test("a deploy talks only to the cloud API, never to a vendor collector", async (t) => {
  const { fake, state, runner } = await harness(t);
  const origins = observeOrigins(t);
  await runner.deploy(capacityStack({ requestId: "req-1", state }));
  await runner.destroy(capacityStack({ requestId: "req-1", state }));
  const cloud = new URL(fake.url).host;
  assert.ok(origins.has(cloud), "the guard observes real traffic, so it cannot pass by seeing nothing");
  assert.deepEqual([...origins], [cloud]);
});

test("the token is not placed in process.env, and Alchemy's files stay in the work directory", async (t) => {
  const { cwdBefore } = { cwdBefore: existsSync(join(process.cwd(), ".alchemy")) };
  const { fake, state, runner } = await harness(t);
  await runner.deploy(capacityStack({ requestId: "req-1", state }));
  assert.equal(process.env.HCLOUD_TOKEN, undefined);
  assert.equal(process.env.ALCHEMY_TELEMETRY_DISABLED, "1");
  assert.equal(process.env.ALCHEMY_HOME, runner.workDir);
  assert.ok(readdirSync(runner.workDir).length > 0, "logs and scratch land in the work directory");
  assert.equal(existsSync(join(process.cwd(), ".alchemy")), cwdBefore, "nothing created in the process cwd");
});
