import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createServiceRuntime } from "../dist/core/index.js";
import { normalizeClientAddress } from "../dist/core/runtime/client-address.js";
import { createNodeHttpServer, nodeClientAddress, ZELAVIS_CLIENT_ADDRESS_HEADER } from "../dist/core/runtime/node-http.js";
import { createNodeRuntimeIngress } from "../dist/adapters/_node-runtime-ingress.js";

const runtime = await createServiceRuntime({
  services: [{ name: "demo", service: {}, api: { v1: [{ id: "demo.who", method: "GET", path: "/who", handler: ({ client }) => ({ status: 200, body: { address: client.address ?? null } }) }] } }],
  prefix: "/api",
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
async function who(port, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/demo/who`, { headers });
  return (await response.json()).address;
}

test("normalizeClientAddress accepts only IP literals and normalizes them", () => {
  assert.equal(normalizeClientAddress("203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeClientAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeClientAddress("2001:db8::1%eth0"), "2001:db8::1");
  assert.equal(normalizeClientAddress("::1"), "::1");
  assert.equal(normalizeClientAddress("1:2:3:4:5:6:7:8"), "1:2:3:4:5:6:7:8");
  assert.equal(normalizeClientAddress("::"), "::");
  for (const bad of ["999.1.1.1", "foo", "", "1.2.3", "1:2:3:4:5:6:7:8:9", "1::2::3", "2001:db8::g", "::ffff:1.2.3.999", "1.2.3.4, 5.6.7.8"]) {
    assert.equal(normalizeClientAddress(bad), undefined, bad);
  }
});

test("a handler sees the peer address, or the named one only from a loopback peer", async () => {
  const plain = createNodeHttpServer(runtime);
  const port = await listen(plain);
  try {
    assert.equal(await who(port), "127.0.0.1");
    assert.equal(await who(port, { [ZELAVIS_CLIENT_ADDRESS_HEADER]: "198.51.100.4" }), "198.51.100.4");
    assert.equal(await who(port, { [ZELAVIS_CLIENT_ADDRESS_HEADER]: "not-an-ip" }), "127.0.0.1");
    // Forwarded-for is ignored unless the listener was told its proxy is trusted.
    assert.equal(await who(port, { "x-forwarded-for": "1.1.1.1, 198.51.100.9" }), "127.0.0.1");
  } finally { await close(plain); }

  const behindProxy = createNodeHttpServer(runtime, { trustForwardedFor: true });
  const proxied = await listen(behindProxy);
  try {
    assert.equal(await who(proxied, { "x-forwarded-for": "1.1.1.1, 198.51.100.9" }), "198.51.100.9");
    assert.equal(await who(proxied, { "x-forwarded-for": "garbage" }), "127.0.0.1");
  } finally { await close(behindProxy); }

  const claimsOnly = createNodeHttpServer(runtime, { trustClientAddressHeader: false });
  const strict = await listen(claimsOnly);
  try {
    assert.equal(await who(strict, { [ZELAVIS_CLIENT_ADDRESS_HEADER]: "198.51.100.4" }), "127.0.0.1");
  } finally { await close(claimsOnly); }
});

test("a peer that is not loopback is its own address whatever headers it sends", () => {
  const request = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  const headers = { [ZELAVIS_CLIENT_ADDRESS_HEADER]: "6.6.6.6", "x-forwarded-for": "7.7.7.7" };
  assert.equal(nodeClientAddress(request("203.0.113.7", headers), { trustForwardedFor: true }), "203.0.113.7");
  assert.equal(nodeClientAddress(request("::ffff:203.0.113.7", headers), { trustForwardedFor: true }), "203.0.113.7");
  assert.equal(nodeClientAddress(request("::1", headers), {}), "6.6.6.6");
  assert.equal(nodeClientAddress(request(undefined, headers), {}), undefined);
});

test("the ingress replaces a client-sent address header with the one it computed", async () => {
  const engine = createNodeHttpServer(runtime);
  const enginePort = await listen(engine);
  for (const trust of [false, true]) {
    const ingress = createNodeRuntimeIngress({ target: () => `http://127.0.0.1:${enginePort}`, trustForwardedFor: trust });
    const port = await Effect.runPromise(ingress.listen({ host: "127.0.0.1", port: 0 }));
    try {
      // Spoofed header from a loopback peer: the ingress drops it; only a trusted forwarded-for may name the caller.
      assert.equal(await who(port, { [ZELAVIS_CLIENT_ADDRESS_HEADER]: "6.6.6.6" }), "127.0.0.1");
      assert.equal(await who(port, { "x-forwarded-for": "9.9.9.9, 198.51.100.9" }), trust ? "198.51.100.9" : "127.0.0.1");
    } finally { await Effect.runPromise(ingress.close); }
  }
  await close(engine);
});
