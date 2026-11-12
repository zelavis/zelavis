import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { createMemorySystemStore } from "zelavis";
import {
  PROVISIONING_STATE_NAMESPACE,
  aesGcmSecretCodec,
  createProvisioningState,
} from "../dist/index.js";

const STACK = "capacity-1";
const STAGE = "prod";
const run = (effect) => Effect.runPromise(effect);

function setup({ secrets = aesGcmSecretCodec(randomBytes(32)), store = createMemorySystemStore() } = {}) {
  const provisioning = createProvisioningState({ store, secrets });
  const acquire = (owner) => run(provisioning.acquire({ stack: STACK, stage: STAGE, owner }));
  return { store, provisioning, acquire };
}

const row = (status, extra = {}) => ({ kind: "resource", status, logicalId: "node", ...extra });
const req = (fqn, value) => ({ stack: STACK, stage: STAGE, fqn, value });
const base = { stack: STACK, stage: STAGE };

/** The cause chain Alchemy's error wrapper carries. */
async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a failure");
}
const tagOf = (error) => String(error?.cause?._tag ?? error?.message ?? error);

test("acquire creates the document at epoch 1 and later acquires bump it", async () => {
  const { acquire } = setup();
  const first = await acquire("worker-a");
  const second = await acquire("worker-b");
  assert.equal(first.epoch, 1);
  assert.equal(second.epoch, 2);
});

test("state round-trips: set, get, list, outputs and delete", async () => {
  const { acquire } = setup();
  const { service } = await acquire("worker-a");
  await run(service.set(req("node", row("created", { attr: { id: 7 } }))));
  await run(service.set(req("key", row("created"))));
  assert.deepEqual((await run(service.get({ ...base, fqn: "node" }))).attr, { id: 7 });
  assert.deepEqual((await run(service.list(base))).sort(), ["key", "node"]);
  assert.equal(await run(service.get({ ...base, fqn: "missing" })), undefined);
  await run(service.setOutput({ ...base, value: { id: 7 } }));
  assert.deepEqual(await run(service.getOutput(base)), { id: 7 });
  await run(service.delete({ ...base, fqn: "key" }));
  assert.deepEqual(await run(service.list(base)), ["node"]);
});

test("concurrent writes under compare-and-set lose no update", async () => {
  const { acquire } = setup();
  const { service } = await acquire("worker-a");
  await Promise.all(
    Array.from({ length: 24 }, (_, index) => run(service.set(req(`r${index}`, row("created", { n: index }))))),
  );
  const listed = await run(service.list(base));
  assert.equal(listed.length, 24);
  for (let index = 0; index < 24; index++) {
    assert.equal((await run(service.get({ ...base, fqn: `r${index}` }))).n, index);
  }
});

test("a superseded worker is fenced on its next read and write, and changes nothing", async () => {
  const { acquire } = setup();
  const stale = await acquire("worker-a");
  await run(stale.service.set(req("node", row("created", { owner: "a" }))));
  const current = await acquire("worker-b");

  const writeFailure = await failureOf(run(stale.service.set(req("node", row("updating", { owner: "stale" })))));
  assert.equal(tagOf(writeFailure), "StateFenced");
  assert.equal(tagOf(await failureOf(run(stale.service.get({ ...base, fqn: "node" })))), "StateFenced");
  assert.equal(tagOf(await failureOf(run(stale.service.delete({ ...base, fqn: "node" })))), "StateFenced");

  assert.equal((await run(current.service.get({ ...base, fqn: "node" }))).owner, "a", "the stale write changed nothing");
  await run(current.service.set(req("node", row("updated", { owner: "b" }))));
  assert.equal((await run(current.service.get({ ...base, fqn: "node" }))).owner, "b");
});

test("the same owner restarting fences its own earlier instance", async () => {
  const { acquire } = setup();
  const before = await acquire("worker-a");
  const after = await acquire("worker-a");
  assert.equal(after.epoch, before.epoch + 1);
  assert.equal(tagOf(await failureOf(run(before.service.set(req("node", row("created")))))), "StateFenced");
});

test("secrets are sealed at rest and revived on read", async () => {
  const { acquire, store } = setup();
  const { service } = await acquire("worker-a");
  await run(service.set(req("key", row("created", { attr: { privateKey: Redacted.make("TOP-SECRET-KEY") } }))));
  const stored = JSON.stringify(await store.get(PROVISIONING_STATE_NAMESPACE, `${STACK}/${STAGE}`));
  assert.ok(!stored.includes("TOP-SECRET-KEY"), "plaintext must not reach the store");
  assert.ok(stored.includes("__sealed__"));
  const back = await run(service.get({ ...base, fqn: "key" }));
  assert.ok(Redacted.isRedacted(back.attr.privateKey));
  assert.equal(Redacted.value(back.attr.privateKey), "TOP-SECRET-KEY");
});

test("provisioning state cannot be created without a secret codec", () => {
  assert.throws(() => createProvisioningState({ store: createMemorySystemStore() }), /secret codec/);
  assert.throws(() => createProvisioningState({ store: createMemorySystemStore(), secrets: {} }), /secret codec/);
});

test("after the owner deletes the stack it reads as empty and cannot write again", async () => {
  const { acquire } = setup();
  const { service } = await acquire("worker-a");
  await run(service.set(req("node", row("created"))));
  await run(service.deleteStack({ stack: STACK, stage: STAGE }));
  assert.deepEqual(await run(service.list(base)), []);
  assert.equal(await run(service.get({ ...base, fqn: "node" })), undefined);
  assert.equal(tagOf(await failureOf(run(service.set(req("node", row("created")))))), "StateFenced");
});

test("a sealed secret cannot be moved to another document", async () => {
  const codec = aesGcmSecretCodec(randomBytes(32));
  const { acquire, store } = setup({ secrets: codec });
  const a = await acquire("worker-a");
  await run(a.service.set(req("key", row("created", { attr: { k: Redacted.make("s3cret") } }))));
  const record = await store.get(PROVISIONING_STATE_NAMESPACE, `${STACK}/${STAGE}`);

  // Copy the sealed document under another stage's key and try to read it there.
  const otherStage = { ...record.value, stage: "other" };
  await store.set(PROVISIONING_STATE_NAMESPACE, `${STACK}/other`, otherStage);
  const other = await run(createProvisioningState({ store, secrets: codec }).acquire({ stack: STACK, stage: "other", owner: "w" }));
  const failure = await failureOf(run(other.service.get({ stack: STACK, stage: "other", fqn: "key" })));
  assert.equal(tagOf(failure), "StateCorrupt");
});

test("a malformed stored document is reported, never trusted", async () => {
  const { store, provisioning } = setup();
  await store.set(PROVISIONING_STATE_NAMESPACE, `${STACK}/${STAGE}`, { v: 1, nonsense: true });
  const exit = await Effect.runPromiseExit(provisioning.acquire({ stack: STACK, stage: STAGE, owner: "w" }));
  assert.ok(Exit.isFailure(exit));
  assert.equal(Cause.squash(exit.cause)._tag, "StateCorrupt");
});

test("compare-and-set conflicts are retried a bounded number of times, then reported", async () => {
  const { acquire, store } = setup();
  const { service } = await acquire("worker-a");
  let attempts = 0;
  const original = store.compareAndSet.bind(store);
  store.compareAndSet = (...args) => {
    attempts++;
    return undefined; // every write loses the race
  };
  const failure = await failureOf(run(service.set(req("node", row("created")))));
  assert.equal(tagOf(failure), "StateContention");
  assert.equal(attempts, 16);
  store.compareAndSet = original;
});

test("a worker cannot reach outside the stack and stage it acquired", async () => {
  const { acquire } = setup();
  const { service } = await acquire("worker-a");
  const failure = await failureOf(run(service.set({ stack: "other", stage: STAGE, fqn: "x", value: row("created") })));
  assert.equal(tagOf(failure), "StateCorrupt");
  assert.equal(await run(service.get({ stack: "other", stage: STAGE, fqn: "x" })), undefined);
});

test("invalid ids are refused", async () => {
  const { provisioning } = setup();
  for (const input of [
    { stack: "", stage: "s", owner: "o" },
    { stack: "a/b", stage: "s", owner: "o" },
    { stack: "a", stage: "s", owner: "" },
  ]) {
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(provisioning.acquire(input))), JSON.stringify(input));
  }
});
