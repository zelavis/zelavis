// The SDK's request behaviour, the same in browsers and servers: typed errors that say what failed and whether a
// repeat may help, deadlines and cancellation, retries only for what is safe to repeat, and one way to page.
import assert from "node:assert/strict";
import test from "node:test";
import { createZelavisClient, pages, ZelavisClientAbortError, ZelavisClientHttpError, ZelavisClientTransportError } from "../dist/sdk/fetch.js";

const scripted = (answers) => {
  const seen = [];
  const fetch = async (input, init = {}) => {
    seen.push({ method: init.method ?? "GET", path: new URL(String(input)).pathname, body: init.body });
    const next = answers.shift() ?? { status: 200, body: {} };
    if (next.hang) return new Promise((_, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });
    if (next.throws) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json", ...(next.headers ?? {}) } });
  };
  return { fetch, seen };
};

test("a failed request says what failed, its code, and whether a repeat may help", async () => {
  const { fetch } = scripted([{ status: 409, body: { error: "Tenant is being moved", code: "tenant-moving" } }, { status: 503, body: {} }]);
  const client = createZelavisClient({ baseUrl: "http://zv.test", fetch });
  const conflict = await client.runtime.config().catch((error) => error);
  assert.ok(conflict instanceof ZelavisClientHttpError);
  assert.deepEqual([conflict.status, conflict.code, conflict.operation, conflict.retryable, conflict.message], [409, "tenant-moving", "GET /runtime/config", false, "Tenant is being moved"]);
  assert.equal((await client.runtime.config().catch((error) => error)).retryable, true);
  const network = await createZelavisClient({ baseUrl: "http://zv.test", fetch: scripted([{ throws: true }]).fetch }).runtime.config().catch((error) => error);
  assert.ok(network instanceof ZelavisClientTransportError);
  assert.match(network.message, /could not reach the server: fetch failed/);
});

test("a deadline and a cancellation abort a request, and say which it was", async () => {
  const slow = createZelavisClient({ baseUrl: "http://zv.test", fetch: scripted([{ hang: true }]).fetch, timeoutMs: 30 });
  const timedOut = await slow.runtime.config().catch((error) => error);
  assert.ok(timedOut instanceof ZelavisClientAbortError);
  assert.deepEqual([timedOut.reason, timedOut.operation], ["timeout", "GET /runtime/config"]);
  const controller = new AbortController();
  const cancellable = createZelavisClient({ baseUrl: "http://zv.test", fetch: scripted([{ hang: true }]).fetch, signal: controller.signal });
  const pending = cancellable.runtime.config().catch((error) => error);
  controller.abort();
  assert.equal((await pending).reason, "cancelled");
});

test("only what is safe to repeat is retried, with backoff, until an answer that is not transient", async () => {
  const reads = scripted([{ status: 503 }, { status: 502 }, { status: 200, body: { rootPath: "/zelavis", api: { basePath: "/zelavis/api/v1", version: "v1" } } }]);
  const reader = createZelavisClient({ baseUrl: "http://zv.test", fetch: reads.fetch, retry: { attempts: 4, baseDelayMs: 1 } });
  assert.equal((await reader.runtime.config()).rootPath, "/zelavis");
  assert.equal(reads.seen.length, 3, "a GET is repeated past 503 and 502");

  const writes = scripted([{ status: 503 }, { status: 200, body: {} }]);
  const writer = createZelavisClient({ baseUrl: "http://zv.test", fetch: writes.fetch, retry: { attempts: 4, baseDelayMs: 1 } });
  const refused = await writer.data("p1").documents.insert("posts", { data: {} }).catch((error) => error);
  assert.equal(refused.status, 503, "a write without an idempotency key is never repeated");
  assert.equal(writes.seen.length, 1);

  const keyed = scripted([{ status: 503 }, { status: 200, body: { id: "a" } }]);
  const keyedWriter = createZelavisClient({ baseUrl: "http://zv.test", fetch: keyed.fetch, retry: { attempts: 3, baseDelayMs: 1 } });
  await keyedWriter.data("p1").documents.insert("posts", { data: {}, idempotencyKey: "once" });
  assert.equal(keyed.seen.length, 2, "a write that carries an idempotency key is repeated: the server applies it once");

  const exhausted = scripted([{ status: 503 }, { status: 503 }]);
  const tired = createZelavisClient({ baseUrl: "http://zv.test", fetch: exhausted.fetch, retry: { attempts: 2, baseDelayMs: 1 } });
  assert.equal((await tired.runtime.config().catch((error) => error)).status, 503, "out of attempts, the last answer is the caller's");
});

test("pages() walks every cursor-paged answer shape once", async () => {
  const answers = { undefined: { rows: [1], next: "b" }, b: { rows: [2], cursor: "c", more: true }, c: { rows: [3], cursor: "d", more: false } };
  const seen = [];
  for await (const page of pages(async (after) => answers[String(after)])) seen.push(...page.rows);
  assert.deepEqual(seen, [1, 2, 3]);
  let calls = 0;
  for await (const _ of pages(async () => { calls += 1; return { next: "same" }; })) { /* a cursor that does not move ends it */ }
  assert.equal(calls, 2);
});
