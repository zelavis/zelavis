// The reference consumer in examples/analytics-feed, run against a real database through the SDK: the table it keeps
// is the Tenant's documents once consistent, stays so as the Tenant changes, resumes from a saved cursor, and starts
// over when the log has been compacted past its cursor.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { apply, emptyFeed, jsonLines, rows, sync } from "../../../examples/analytics-feed/feed.mjs";

const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";
const operator = { id: "operator", type: "user", permissions: ["database.backup", "database.inspect", "database.read", "database.write"] };

const clientFor = (api) => createZelavisClient({
  baseUrl: "http://zv.test",
  rootPath: "/zelavis",
  fetch: async (input, init) => {
    const url = new URL(String(input));
    const match = /\/tenants\/([^/]+)\/export$/.exec(url.pathname);
    assert.ok(url.pathname.startsWith(PROXY) && match);
    const route = defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.tenants.export");
    const response = await route.handler({ service: api, params: { tenantId: decodeURIComponent(match[1]) }, query: new URLSearchParams(), body: init.body === undefined ? {} : JSON.parse(init.body), principal: operator, headers: {}, request: undefined });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "content-type": "application/json" } });
  },
});

const live = async (handle) => (await handle.documents.findMany({ collection: "posts" })).map((doc) => `${doc.id}:${doc.data.title}`).sort();
const held = (feed) => rows(feed).filter((row) => row.collection === "posts").map((row) => `${row.id}:${row.title}`).sort();

test("the reference consumer keeps the Tenant's documents, carries on from a saved cursor, and starts over when outrun", async (t) => {
  const opened = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const api = opened.api;
  const handle = api.forTenant("acme");
  await handle.documents.createCollection({ name: "posts" });
  for (const id of ["a", "b", "c", "d", "e"]) await handle.documents.insert({ collection: "posts", id, data: { title: id } });
  const client = clientFor(api);

  let pages = 0;
  const feed = await sync({ client, projectId: "p1", tenantId: "acme", limit: 2, onPage: () => { pages += 1; } });
  assert.ok(pages > 1);
  assert.deepEqual(held(feed), await live(handle));
  assert.match(jsonLines(feed).split("\n")[0], /"collection":"posts"/);

  // Changes after the export arrive on the same cursor; the saved feed is plain JSON.
  const saved = JSON.parse(JSON.stringify(feed));
  await handle.documents.update({ collection: "posts", id: "a", data: { title: "changed" } });
  await handle.documents.delete({ collection: "posts", id: "b" });
  await handle.documents.insert({ collection: "posts", id: "f", data: { title: "f" } });
  await sync({ client, projectId: "p1", tenantId: "acme", feed: saved });
  assert.deepEqual(held(saved), await live(handle));
  assert.ok(!held(saved).some((row) => row.startsWith("b:")));

  // The consumer was away while the log was compacted past its cursor: it starts over, and ends equal.
  await handle.documents.update({ collection: "posts", id: "c", data: { title: "later" } });
  await Effect.runPromise(opened.database.maintenance.compact({ keep: 0 }));
  await handle.documents.insert({ collection: "posts", id: "g", data: { title: "g" } });
  await sync({ client, projectId: "p1", tenantId: "acme", feed: saved });
  assert.deepEqual(held(saved), await live(handle));
});

test("apply is by version: an old entry changes nothing and a retraction is not undone by a repeat", () => {
  const feed = emptyFeed();
  const identity = { namespace: "doc/posts", key: "x" };
  const body = (title) => Buffer.from(JSON.stringify({ id: "x", collection: "posts", version: 1, data: { title } })).toString("base64");
  apply(feed, [{ kind: "put", seq: 1, version: 2, identity, body: body("two") }]);
  apply(feed, [{ kind: "put", seq: 1, version: 1, identity, body: body("one") }]);
  assert.equal(rows(feed)[0].title, "two");
  apply(feed, [{ kind: "retract", seq: 1, version: 3 }, { kind: "put", seq: 1, version: 2, identity, body: body("two") }]);
  assert.deepEqual(rows(feed), []);
});
