import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Deferred } from "effect";
import { installServiceBroker } from "../app/service-pages.ts";
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
function fixture(reply) {
  const messages = new Map(), frameEvents = new Map();
  const source = { postMessage: reply };
  const owner = { addEventListener: (name, callback) => messages.set(name, callback), removeEventListener: name => messages.delete(name) };
  const frame = { isConnected: true, contentWindow: source, ownerDocument: { defaultView: owner }, addEventListener: (name, callback) => frameEvents.set(name, callback), removeEventListener: name => frameEvents.delete(name), insertAdjacentElement() {} };
  return { frame, source, messages, frameEvents, send: (data, from = source) => messages.get("message")?.({ source: from, origin: "null", data: { zelavis: "service-page-request", ...data } }) };
}
const grant = { serviceName: "fixture", apiPath: "/zelavis/api/v1/plugins/fixture" };
test("the source window is authenticated before performing any namespace request", async () => {
  const paths = [];
  globalThis.fetch = async path => { paths.push(path); return Response.json({ safe: true }); };
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const response = yield* Deferred.make();
    const host = fixture(value => { if (value.id === "valid") Effect.runSync(Deferred.succeed(response, value)); });
    yield* installServiceBroker(host.frame, grant);
    host.send({ id: "spoof", path: "/read" }, {});
    assert.deepEqual(paths, []);
    host.send({ id: "unsupported", path: "/read", method: 42 });
    assert.deepEqual(paths, []);
    host.send({ id: "valid", path: "/read" });
    const value = yield* Deferred.await(response).pipe(Effect.timeout("1 second"));
    assert.equal(value.ok, true); assert.deepEqual(value.body, { safe: true });
    assert.deepEqual(paths, [grant.apiPath + "/read"]);
  })));
});
test("closing a page scope aborts pending work and removes its broker listener", async () => {
  let signal, host;
  globalThis.fetch = (_path, options) => { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })); };
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    host = fixture(() => {});
    yield* installServiceBroker(host.frame, grant);
    host.send({ id: "pending", path: "/slow" });
    assert.ok(signal);
  })));
  assert.equal(signal.aborted, true); assert.equal(host.messages.size, 0); assert.equal(host.frameEvents.size, 0);
});
