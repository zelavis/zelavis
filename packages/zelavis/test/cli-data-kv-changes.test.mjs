// KV changes through the SDK and the CLI: both hand back the whole page.
//
// The cursor is where the read stopped, which can be past the last change, and
// `more` says whether to read again now. A client that dropped either would be
// back to continuing from the last change, which a long run of writes to other
// namespaces turns into the same empty answer on every call.
import assert from "node:assert/strict";
import test from "node:test";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";

const PAGE = {
  changes: [{
    cursor: "c1",
    eventId: "acme:1",
    key: "theme",
    type: "set",
    revision: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    value: { mode: "dark" },
  }],
  cursor: "c9",
  more: true,
};

const recordingFetch = (requests) => async (input, init) => {
  requests.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify(PAGE), { status: 200, headers: { "content-type": "application/json" } });
};

test("kv changes: the SDK returns the cursor and whether more follows", async () => {
  const requests = [];
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: recordingFetch(requests) });

  assert.deepEqual(await client.data("p1").kv.changes("settings", { after: "c0", limit: 5 }), PAGE);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/kv\/settings\/changes$/);
  assert.deepEqual(requests[0].body, { after: "c0", limit: 5 });
});

test("kv changes: the CLI prints the cursor and whether more follows", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });
  globalThis.fetch = recordingFetch(requests);
  const lines = [];
  console.log = (line) => lines.push(String(line));

  await runDataCommand(["kv-changes", "settings", "--project", "p1", "--url", "http://zv.test/zelavis", "--json"]);
  assert.deepEqual(JSON.parse(lines.join("\n")), PAGE);

  lines.length = 0;
  await runDataCommand(["kv-changes", "settings", "--project", "p1", "--url", "http://zv.test/zelavis", "--after", "c0"]);
  assert.deepEqual(lines.join("\n").split("\n"), ["set\ttheme\tv1\tc1", "cursor\tc9", "more\ttrue"]);
  assert.deepEqual(requests.at(-1).body, { after: "c0" });
});
