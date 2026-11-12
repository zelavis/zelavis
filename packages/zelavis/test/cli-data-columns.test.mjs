// Declared columns through the SDK and the CLI: the same request the HTTP route
// takes, so the three cannot drift.
import assert from "node:assert/strict";
import test from "node:test";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";

const RESULT = { columns: ["author", "status"], documents: 3 };

const recordingFetch = (requests, body) => async (input, init) => {
  requests.push({ url: String(input), method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

test("columns: the SDK creates a collection with them and changes them on their own route", async () => {
  const requests = [];
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: recordingFetch(requests, RESULT) });
  const data = client.data("p1");

  await data.collections.create({ name: "posts", columns: ["status"] });
  assert.match(requests[0].url, /\/runtime\/projects\/p1\/data\/documents\/collections$/);
  assert.deepEqual(requests[0].body, { name: "posts", columns: ["status"] });

  assert.deepEqual(await data.collections.setColumns("posts", ["status", "author"]), RESULT);
  assert.match(requests[1].url, /\/data\/documents\/posts\/columns$/);
  assert.deepEqual(requests[1].body, { columns: ["status", "author"] });

  await data.collections.setColumns("posts", null);
  assert.deepEqual(requests[2].body, { columns: null });
});

test("columns: the CLI takes them as a list, or all", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });
  globalThis.fetch = recordingFetch(requests, RESULT);
  const lines = [];
  console.log = (line) => lines.push(String(line));
  const common = ["--project", "p1", "--url", "http://zv.test/zelavis"];

  await runDataCommand(["create-collection", "posts", "--columns", "status, author", ...common]);
  assert.deepEqual(requests.at(-1).body, { name: "posts", columns: ["status", "author"] });

  await runDataCommand(["set-columns", "posts", "--columns", "status,author", ...common, "--json"]);
  assert.match(requests.at(-1).url, /\/documents\/posts\/columns$/);
  assert.deepEqual(requests.at(-1).body, { columns: ["status", "author"] });
  assert.deepEqual(JSON.parse(lines.at(-1)), RESULT);

  await runDataCommand(["set-columns", "posts", "--columns", "all", ...common]);
  assert.deepEqual(requests.at(-1).body, { columns: null });
  assert.equal(lines.at(-1), "posts indexes author, status; rewrote 3 documents.");

  await assert.rejects(runDataCommand(["set-columns", "posts", ...common]), /requires --columns/);
});
