import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { decode, Projects, projects, request, projectConfig } from "../app/api.ts";
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const config = { api: { basePath: "/zelavis/api/v1" }, rootPath: "/zelavis" };
test("uses runtime.status and retains pending deletion when reading projects", async () => {
  globalThis.fetch = async () => Response.json({ projects: [{ id: "new", name: "New", runtime: { status: "failed", error: "Cleanup failed" }, deletion: { status: "failed" } }] });
  const list = await Effect.runPromise(projects(config));
  assert.equal(list[0].status, "failed");
  assert.equal(list[0].error, "Cleanup failed");
  assert.deepEqual(list[0].deletion, { status: "failed" });
});
test("refuses malformed project data instead of displaying invented state", async () => {
  await assert.rejects(Effect.runPromise(decode(Projects, { projects: [{ id: "x", name: "X", runtime: {} }] })), /unexpected response/);
});
test("project APIs stay under the exact encoded project proxy", async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); return Response.json(config); };
  const scoped = await Effect.runPromise(projectConfig(config, "customer/a"));
  assert.equal(calls[0], "/zelavis/api/v1/runtime/projects/customer%2Fa/proxy/zelavis/api/v1/runtime/config");
  assert.equal(scoped.api.basePath, "/zelavis/api/v1/runtime/projects/customer%2Fa/proxy/zelavis/api/v1");
});
test("does not fetch outside the API mount", async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  await assert.rejects(Effect.runPromise(request("https://evil.test")), /outside the Zelavis API/);
  assert.equal(fetched, false);
});
test("returns permission errors with status and message", async () => {
  globalThis.fetch = async () => Response.json({ error: "Missing project grant" }, { status: 403 });
  await assert.rejects(Effect.runPromise(request("/zelavis/api/v1/runtime/access")), error => error.status === 403 && error.message === "Missing project grant");
});
test("interrupting a request aborts the fetch", async () => {
  let signal;
  globalThis.fetch = (_url, init) => { signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })); };
  const { Fiber } = await import("effect");
  const fiber = Effect.runFork(request("/zelavis/api/v1/runtime/access"));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(signal.aborted, true);
});
test("refuses an oversized response while streaming and cancels its reader", async () => {
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { canceled = true; } }));
  await assert.rejects(Effect.runPromise(request("/zelavis/api/v1/runtime/access")), /exceeded the dashboard limit/);
  assert.equal(canceled, true);
});
