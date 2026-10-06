// Alchemy deploys running on the Zelavis-backed provisioning state: fencing
// stops a superseded worker before it reaches the cloud, a restarted worker
// recovers a crashed create, and the generated deploy key is sealed at rest.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import * as Effect from "effect/Effect";
import { createMemorySystemStore } from "zelavis";
import { startFakeHetzner } from "./fake-hetzner.mjs";
import { STACK, STAGE, capacityStack, makeRunner } from "./headless.mjs";
import { PROVISIONING_STATE_NAMESPACE, aesGcmSecretCodec, createProvisioningState } from "../dist/index.js";

const codec = () => aesGcmSecretCodec(randomBytes(32));

async function harness(t) {
  const fake = await startFakeHetzner();
  t.after(() => fake.close());
  const store = createMemorySystemStore();
  const fault = { failNextCreatedWrite: 0 };
  const faulty = Object.create(store);
  faulty.compareAndSet = (namespace, key, updatedAt, value, expected) => {
    if (fault.failNextCreatedWrite > 0 && JSON.stringify(value).includes('"status":"created"')) {
      fault.failNextCreatedWrite--;
      throw new Error("injected store failure");
    }
    return store.compareAndSet(namespace, key, updatedAt, value, expected);
  };
  const provisioning = createProvisioningState({ store: faulty, secrets: codec() });
  const acquire = (owner) => Effect.runPromise(provisioning.acquire({ stack: STACK, stage: STAGE, owner }));
  const creates = () => fake.log.filter((line) => line.startsWith("POST /servers")).length;
  const rawDocument = () => store.get(PROVISIONING_STATE_NAMESPACE, `${STACK}/${STAGE}`);
  return { fake, store, fault, acquire, creates, rawDocument };
}

test("a deploy on the Zelavis state creates one machine and persists its state", async (t) => {
  const { fake, acquire, creates } = await harness(t);
  const state = await acquire("worker-a");
  const runner = makeRunner({ fake, state });
  const result = await runner.deploy(capacityStack({ requestId: "req-1", state }));
  await runner.deploy(capacityStack({ requestId: "req-1", state }));
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1);
  assert.equal((await Effect.runPromise(state.service.get({ stack: STACK, stage: STAGE, fqn: "node" }))).status, "created");
  assert.equal(result.id, [...fake.servers.keys()][0]);
});

test("a superseded worker is stopped before it can create anything", async (t) => {
  const { fake, acquire, creates } = await harness(t);
  const stale = await acquire("worker-a");
  const current = await acquire("worker-b"); // takes over; worker-a is now fenced
  await assert.rejects(
    () => makeRunner({ fake, state: stale }).deploy(capacityStack({ requestId: "req-1", state: stale })),
    /StateFenced/,
  );
  assert.equal(fake.servers.size, 0, "the stale worker reached no cloud");
  assert.equal(creates(), 0);

  await makeRunner({ fake, state: current }).deploy(capacityStack({ requestId: "req-1", state: current }));
  assert.equal(fake.servers.size, 1, "the current owner proceeds");
});

test("a worker superseded mid-flight cannot delete what the new owner holds", async (t) => {
  const { fake, acquire } = await harness(t);
  const first = await acquire("worker-a");
  await makeRunner({ fake, state: first }).deploy(capacityStack({ requestId: "req-1", state: first }));
  const second = await acquire("worker-b");
  await assert.rejects(
    () => makeRunner({ fake, state: first }).destroy(capacityStack({ requestId: "req-1", state: first })),
    /StateFenced/,
  );
  assert.equal(fake.servers.size, 1, "the machine survives the stale destroy");
  await makeRunner({ fake, state: second }).destroy(capacityStack({ requestId: "req-1", state: second }));
  assert.equal(fake.servers.size, 0);
});

test("a restarted worker recovers a crash after the cloud create without creating again", async (t) => {
  const { fake, acquire, fault, creates, rawDocument } = await harness(t);
  const first = await acquire("worker-a");
  fault.failNextCreatedWrite = 1;
  await assert.rejects(() => makeRunner({ fake, state: first }).deploy(capacityStack({ requestId: "req-1", state: first })));
  assert.equal(fake.servers.size, 1, "the cloud made the machine before the crash");
  assert.equal((await rawDocument()).value.resources.node.status, "creating", "the intent was durable first");

  const restarted = await acquire("worker-a"); // the same worker, after a restart
  await makeRunner({ fake, state: restarted }).deploy(capacityStack({ requestId: "req-1", state: restarted }));
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1, "the retry created nothing");
});

test("the generated deploy key never reaches the store in the clear", async (t) => {
  const { fake, acquire, rawDocument } = await harness(t);
  const state = await acquire("worker-a");
  await makeRunner({ fake, state }).deploy(capacityStack({ requestId: "req-1", state }));
  const stored = JSON.stringify((await rawDocument()).value);
  assert.ok(stored.includes("__sealed__"), "a secret was stored, sealed");
  assert.ok(!stored.includes("PRIVATE KEY"), "no private key material in the clear");
});
