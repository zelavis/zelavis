// A partition's writer lease through the JS runtime API, the HTTP routes, the SDK and the CLI: one scenario, each
// against a database of its own, has to come out the same — status before and after, promotion, the refusals (a live
// lease, a follower behind, nothing to take over), and giving the lease up.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { defineDatabaseService } from "../dist/db/index.js";
import { acquireWriter, memoryLeaseStore, renewWriter } from "../dist/db/writer-lease.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runFollowersCommand } from "../dist/cli/followers.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { fakePlatform, routeTable, runCli, steady } from "./_platform.mjs";
import { leaderFetch } from "./fixtures/leader-routes.mjs";

const operator = { id: "op", type: "service", permissions: ["database.replicate"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const DATA = "/zelavis/api/v1/runtime/projects/p1/data";
const platformOf = (api) => fakePlatform({ prefix: DATA, principal: operator, routes: routeTable([{ basePath: "", api: defineDatabaseService(api).api, context: api }]) });

const surfaces = {
  js: (api) => api.followers,
  http: (api) => {
    const call = platformOf(api);
    const answered = async (method, path, body) => {
      const response = await call(`http://zv.test${DATA}${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error), { _tag: value.code });
      return value;
    };
    return {
      lease: (partition) => answered("GET", `/followers/${partition}/lease`),
      promote: (partition, input) => answered("POST", `/followers/${partition}/lease/promote`, input),
      demote: (partition) => answered("POST", `/followers/${partition}/lease/demote`, {}),
    };
  },
  sdk: (api) => createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: leaderFetch(api) }).followers("p1"),
  cli: (api) => {
    const fetchImplementation = leaderFetch(api);
    const cli = (args) => runCli(runFollowersCommand, [...args, "--project", "p1", "--url", BASE, "--json"], fetchImplementation).then(JSON.parse);
    return {
      lease: (partition) => cli(["lease", partition]),
      promote: (partition, { owner, ttlMillis, allowDataLoss }) => cli(["promote", partition, "--owner", owner, "--ttl-millis", String(ttlMillis), ...(allowDataLoss ? ["--allow-data-loss"] : [])]),
      demote: (partition) => cli(["demote", partition]),
    };
  },
};

const outcome = async (run) => {
  try { return { answer: steady(await run()) }; } catch (error) {
    return { refused: error?._tag ?? error?.body?.code ?? String(error?.message ?? error) };
  }
};
/** Times differ between runs; the shape and the rest must not. */
const timeless = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (key === "expiresAt" ? (entry === 0 ? 0 : "<time>") : entry)));

const scenario = async (api, leases, followers) => {
  const record = {};
  record.unleased = await outcome(() => followers.lease("acme"));
  record.nothingToTakeOver = await outcome(() => followers.promote("acme", { owner: "B", ttlMillis: 2000 }));

  // A writer elsewhere holds the lease with followers having acknowledged through 50.
  const first = await Effect.runPromise(acquireWriter(leases, { partition: "acme", owner: "A", ttlMillis: 100 }));
  await Effect.runPromise(renewWriter(leases, first, { ttlMillis: 100, acknowledgedHead: 50 }));
  record.live = await outcome(() => followers.lease("acme"));
  record.stillHeld = await outcome(() => followers.promote("acme", { owner: "B", ttlMillis: 2000 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  record.expired = await outcome(() => followers.lease("acme"));
  record.behind = await outcome(() => followers.promote("acme", { owner: "B", ttlMillis: 2000 }));
  record.lossy = await outcome(() => followers.promote("acme", { owner: "B", ttlMillis: 2000, allowDataLoss: true }));
  record.mine = await outcome(() => followers.lease("acme"));
  record.twice = await outcome(() => followers.promote("acme", { owner: "B", ttlMillis: 2000 }));
  record.demoted = await outcome(() => followers.demote("acme"));
  record.demotedAgain = await outcome(() => followers.demote("acme"));
  record.released = await outcome(() => followers.lease("acme"));
  return timeless(record);
};

test("a writer lease comes out the same through JS, HTTP, the SDK and the CLI", { timeout: 120_000 }, async (t) => {
  const results = {};
  for (const [name, surface] of Object.entries(surfaces)) {
    const leases = memoryLeaseStore();
    const opened = await openTemporaryDatabase(t, { crossTenantRefresh: false, leases });
    await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
    results[name] = await scenario(opened.api, leases, surface(opened.api));
  }
  const js = results.js;
  assert.equal(js.unleased.answer.held, false);
  assert.equal(js.unleased.answer.lease, undefined);
  assert.equal(js.nothingToTakeOver.refused, "NoWriterLease");
  assert.equal(js.live.answer.expired, false);
  assert.equal(js.stillHeld.refused, "LeaseStillHeld");
  assert.equal(js.expired.answer.expired, true);
  assert.equal(js.behind.refused, "FollowerBehind", "this copy holds none of the 50 acknowledged positions");
  assert.equal(js.lossy.answer.lostPositions, 49, "the copy holds its one position (the collection), so 49 of the 50 acknowledged are missing");
  assert.equal(js.lossy.answer.lease.epoch, 2);
  assert.equal(js.mine.answer.held, true);
  assert.ok(js.twice.refused, "a database holding the lease does not promote again");
  assert.equal(js.demoted.answer.released, true);
  assert.equal(js.demotedAgain.answer.released, false);
  assert.equal(js.released.answer.held, false);
  assert.equal(js.released.answer.expired, true, "a released lease is expired");
  for (const name of ["http", "sdk", "cli"]) {
    for (const step of Object.keys(js)) {
      if (step === "twice") { assert.ok(results[name][step].refused, `${name}: ${step} is refused`); continue; }
      assert.deepEqual(results[name][step], js[step], `${name}: ${step}`);
    }
  }
});
