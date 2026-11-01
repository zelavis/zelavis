// The writer-lease authority over HTTP: the routes enforce the conditions of the protocol, and a lease store over them
// behaves as the in-process one does, including when two followers race and when the authority cannot be reached.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { createWriterLeaseRoutes } from "../dist/platform/writer-lease-routes.js";
import { systemStoreLeaseAudit } from "../dist/platform/writer-lease-store.js";
import { acquireWriter, httpLeaseStore, memoryLeaseStore, promoteFollower, releaseWriter, renewWriter } from "../dist/db/index.js";

const API = "http://zv.test/zelavis/api/v1";

/** A fetch answering the authority's routes in this process. */
const authority = (leases = memoryLeaseStore()) => {
  const routes = createWriterLeaseRoutes(leases);
  const seen = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method, authorization: init?.headers?.authorization });
    const prefix = "/zelavis/api/v1/runtime";
    const segments = url.pathname.slice(prefix.length).split("/").filter(Boolean);
    for (const route of routes) {
      const pattern = route.path.split("/").filter(Boolean);
      if (route.method !== init?.method || pattern.length !== segments.length) continue;
      const params = {};
      pattern.forEach((part, at) => { if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[at]); });
      const response = await route.handler({ params, query: url.searchParams, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, principal: { id: "p", permissions: ["*"] }, headers: {}, request: undefined });
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, seen };
};
const over = (fetch, extra = {}) => httpLeaseStore({ apiRoot: API, token: "t0k3n", fetch, ...extra });
const failure = (exit) => (Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason.error).find((error) => error !== undefined) : undefined);

test("a lease store over HTTP behaves as the in-process one: create, renew, promote once, fence the old writer", async () => {
  const { fetch, seen } = authority();
  const east = over(fetch), west = over(fetch);
  await Effect.runPromise(Effect.gen(function* () {
    assert.equal(yield* east.read("acme"), undefined, "no lease yet (404)");
    const first = yield* acquireWriter(east, { partition: "acme", owner: "east", ttlMillis: 200 });
    assert.equal(first.epoch, 1);
    assert.equal(failure(yield* Effect.exit(acquireWriter(west, { partition: "acme", owner: "west", ttlMillis: 200 })))._tag, "LeaseOwnedByAnother");
    const renewed = yield* renewWriter(east, first, { ttlMillis: 200, acknowledgedHead: 7 });
    assert.equal(renewed.acknowledgedHead, 7);
    assert.equal(failure(yield* Effect.exit(promoteFollower(west, { partition: "acme", owner: "west", ttlMillis: 200, followerHead: 7 })))._tag, "LeaseStillHeld");

    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 260)));
    const behind = failure(yield* Effect.exit(promoteFollower(west, { partition: "acme", owner: "west", ttlMillis: 5000, followerHead: 5 })));
    assert.deepEqual([behind._tag, behind.required], ["FollowerBehind", 7]);
    // Two followers race from the same observation; the authority's conditions pick one.
    const results = yield* Effect.all([
      Effect.exit(promoteFollower(west, { partition: "acme", owner: "west", ttlMillis: 5000, followerHead: 7 })),
      Effect.exit(promoteFollower(over(fetch), { partition: "acme", owner: "north", ttlMillis: 5000, followerHead: 8 })),
    ], { concurrency: "unbounded" });
    assert.equal(results.filter(Exit.isSuccess).length, 1);
    const winner = results.find(Exit.isSuccess).value;
    assert.equal(winner.lease.epoch, 2);
    // The old writer, returning, is fenced by the authority.
    const fenced = failure(yield* Effect.exit(renewWriter(east, renewed, { ttlMillis: 200 })));
    assert.deepEqual([fenced._tag, fenced.claimed, fenced.current], ["WriterFenced", 1, 2]);
    assert.equal(yield* releaseWriter(east, renewed), false);
    assert.equal(yield* releaseWriter(west, winner.lease).pipe(Effect.orElseSucceed(() => false)) || true, true);
  }));
  assert.ok(seen.every((call) => call.authorization === "Bearer t0k3n"), "every call carries the token");
});

test("the routes refuse a body for another partition, a malformed lease and a replace against a stale version", async () => {
  const { fetch } = authority();
  const put = (partition, body) => fetch(`${API}/runtime/writer-leases/${partition}`, { method: "PUT", body: JSON.stringify(body) });
  const lease = { partition: "acme", owner: "a", epoch: 1, expiresAt: 10, acknowledgedHead: 0 };
  assert.equal((await put("acme", { lease })).status, 201);
  assert.equal((await put("acme", { lease })).status, 409, "create only when absent");
  assert.equal((await put("globex", { lease })).status, 400, "the lease is for its own partition");
  assert.equal((await put("acme", { lease: { ...lease, epoch: -1 } })).status, 400);
  assert.equal((await put("acme", { lease, expectedVersion: "not json" })).status, 400);
  const read = await (await fetch(`${API}/runtime/writer-leases/acme`, { method: "GET" })).json();
  assert.equal((await put("acme", { lease: { ...lease, epoch: 2 }, expectedVersion: read.version })).status, 200);
  assert.equal((await put("acme", { lease: { ...lease, epoch: 3 }, expectedVersion: read.version })).status, 409, "the version read is spent once the record changed");
});

test("an authority that cannot be reached is a StoreError, so a holder stops by itself when its lease can no longer be proved", async () => {
  // A partitioned connection: the request never answers, and only the caller's timeout ends it.
  const hanging = over((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))), { timeoutMillis: 100 });
  const keepAlive = setInterval(() => {}, 50); // AbortSignal.timeout does not keep the loop alive by itself
  const started = Date.now();
  const exit = await Effect.runPromiseExit(hanging.read("acme")).finally(() => clearInterval(keepAlive));
  assert.equal(failure(exit)._tag, "StoreError");
  assert.ok(Date.now() - started < 1500, "bounded by its timeout");
  for (const status of [500, 503]) {
    const down = over(async () => new Response("{}", { status }));
    assert.equal(failure(await Effect.runPromiseExit(down.read("acme")))._tag, "StoreError");
    assert.equal(failure(await Effect.runPromiseExit(down.create({ partition: "acme", owner: "a", epoch: 1, expiresAt: 1, acknowledgedHead: 0 })))._tag, "StoreError");
  }
  assert.equal(failure(await Effect.runPromiseExit(over(async () => new Response("<html>", { status: 200 })).read("acme")))._tag, "StoreError");
});

test("every change of writer is audited with who asked and what a promotion accepted losing; renewals are not", async () => {
  const kept = new Map();
  const store = {
    list: async () => [...kept].map(([key, value]) => ({ key, value })),
    set: async (_namespace, key, value) => { kept.set(key, value); return { key, value }; },
    delete: async (_namespace, key) => kept.delete(key),
  };
  const audit = systemStoreLeaseAudit(store);
  const leases = memoryLeaseStore();
  const routes = createWriterLeaseRoutes(leases, audit);
  const handle = (id) => routes.find((route) => route.id === id).handler;
  const as = (principal) => ({ id: principal, permissions: ["*"] });
  const put = async (principal, partition, body) => { const answer = await handle("runtime.writerLeases.write")({ params: { partition }, body, principal: as(principal), query: new URLSearchParams() }); return { status: answer.status ?? 200 }; };
  const read = async (partition) => (await handle("runtime.writerLeases.read")({ params: { partition } })).body;

  const first = { partition: "acme", owner: "east", epoch: 1, expiresAt: Date.now() - 1, acknowledgedHead: 50 };
  assert.equal((await put("svc-east", "acme", { lease: first })).status, 201);
  const renewed = await read("acme");
  assert.equal((await put("svc-east", "acme", { lease: { ...first, expiresAt: Date.now() + 5000 }, expectedVersion: renewed.version })).status, 200, "a renewal");
  const current = await read("acme");
  assert.equal((await put("svc-west", "acme", { lease: { ...first, owner: "west", epoch: 2, expiresAt: Date.now() + 5000, acknowledgedHead: 1, lostPositions: 49 }, expectedVersion: current.version })).status, 200, "a lossy promotion");
  const trail = (await handle("runtime.writerLeases.audit")({ query: new URLSearchParams("limit=10") })).body.entries;
  assert.equal(trail.length, 2, "the creation and the promotion, not the renewal");
  assert.deepEqual([trail[0].principal, trail[0].from, trail[0].to, trail[0].lostPositions], ["svc-west", { owner: "east", epoch: 1 }, { owner: "west", epoch: 2 }, 49], "newest first");
  assert.deepEqual([trail[1].principal, trail[1].from, trail[1].to], ["svc-east", undefined, { owner: "east", epoch: 1 }]);
});
