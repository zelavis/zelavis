import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { Effect } from "effect";
import { createNodeRuntimeIngress } from "../dist/adapters/_node-runtime-ingress.js";
import { NODE_RUNTIME_READY_PATH } from "../dist/adapters/_node-runtime-protocol.js";

async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Ingress condition did not become true.");
}
async function fixture() {
  const sockets = new Set();
  const engine = createServer((_, response) => response.end("engine"));
  engine.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  engine.on("upgrade", (_, socket, head) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", bytes => socket.write(bytes));
    // This echo protocol finishes its response once its input has ended.
    socket.once("end", () => socket.end());
  });
  engine.listen(0, "127.0.0.1"); await once(engine, "listening");
  const ingress = createNodeRuntimeIngress({ queueLimit: 1, target: () => `http://127.0.0.1:${engine.address().port}` });
  const port = await Effect.runPromise(ingress.listen({ host: "127.0.0.1", port: 0 }));
  return { ingress, port, url: `http://127.0.0.1:${port}`,
    close: async () => { await Effect.runPromise(ingress.close); for (const socket of sockets) socket.destroy(); await new Promise(resolve => engine.close(resolve)); },
  };
}

test("a cancelled queued HTTP request frees its admission slot", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.ingress.admission.pause);
    const controller = new AbortController();
    const pending = assert.rejects(fetch(f.url, { signal: controller.signal }), error => error.name === "AbortError");
    await until(() => f.ingress.admission.snapshot().waiting === 1);
    controller.abort(); await pending;
    await until(() => f.ingress.admission.snapshot().waiting === 0);
    await Effect.runPromise(f.ingress.admission.resume);
    assert.equal(await (await fetch(f.url)).text(), "engine");
  } finally { await f.close(); }
});

test("an accepted upgrade tunnel survives a drain deadline and still transfers bytes", { timeout: 5000 }, async () => {
  const f = await fixture(), client = connect(f.port, "127.0.0.1");
  try {
    await once(client, "connect");
    const handshake = once(client, "data");
    client.write("GET /echo HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");
    assert.match(String((await handshake)[0]), /101 Switching Protocols/);
    const before = once(client, "data"); client.write("before"); assert.equal(String((await before)[0]), "before");
    assert.equal(f.ingress.admission.snapshot().active, 1);
    await Effect.runPromise(f.ingress.admission.pause);
    await assert.rejects(Effect.runPromise(f.ingress.admission.drain(10)), error => error._tag === "RuntimeDrainTimeout");
    await Effect.runPromise(f.ingress.admission.resume);
    const after = once(client, "data"); client.write("after"); assert.equal(String((await after)[0]), "after");
    assert.equal(client.destroyed, false);
    client.destroy();
    await until(() => f.ingress.admission.snapshot().active === 0);
  } finally { client.destroy(); await f.close(); }
});

test("public ingress refuses private readiness in origin and absolute request forms", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}${NODE_RUNTIME_READY_PATH}`)).status, 404);
    const client = connect(f.port, "127.0.0.1");
    try {
      await once(client, "connect");
      const reply = once(client, "data");
      client.write(`GET ${f.url}/a/../${NODE_RUNTIME_READY_PATH.slice(1)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      assert.match(String((await reply)[0]), /404 Not Found/);
    } finally { client.destroy(); }
  } finally { await f.close(); }
});
