import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";

import { createNodeHttpServer } from "../dist/core/runtime/node-http.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Sends a raw request line so malformed input reaches the server verbatim. */
function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(payload));
    let received = "";
    // Keep-alive means the socket may stay open after the response, so resolve
    // on the first bytes rather than waiting for close.
    socket.setTimeout(5_000, () => {
      socket.destroy();
      if (received) resolve(received);
      else reject(new Error("no response before timeout"));
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      socket.destroy();
      resolve(received);
    });
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
  });
}

/** Fails the test if any rejection escapes while the body runs. */
async function withRejectionSentinel(body) {
  const escaped = [];
  const onUnhandled = (reason) => escaped.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    // Give a rejected promise a turn to surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(
    escaped.map((reason) => String(reason?.message ?? reason)),
    [],
    "no rejection may escape the HTTP boundary",
  );
}

test("a throwing runtime still answers the client", async () => {
  await withRejectionSentinel(async () => {
    const server = createNodeHttpServer({
      fetch: async () => {
        throw new Error("boom: /secret/path/detail");
      },
    });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/anything`);
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error, "Internal error");
      assert.ok(
        !JSON.stringify(body).includes("/secret/path/detail"),
        "the boundary must not leak the exception message",
      );
    } finally {
      await close(server);
    }
  });
});

test("a request the runtime cannot represent is answered, not dropped", async () => {
  await withRejectionSentinel(async () => {
    const server = createNodeHttpServer({
      fetch: async () => new Response("ok"),
    });
    const port = await listen(server);
    try {
      // `Host: [` passes Node's parser but makes the Web `Request` base URL
      // invalid, so conversion throws before any handler runs. Without a
      // boundary the client receives nothing at all.
      const received = await rawRequest(
        port,
        "GET /x HTTP/1.1\r\nHost: [\r\n\r\n",
      );
      assert.match(
        received,
        /^HTTP\/1\.1 400/,
        `expected a 400 status line, received: ${JSON.stringify(received.slice(0, 80))}`,
      );
    } finally {
      await close(server);
    }
  });
});

test("a failing response stream does not hang the process", async () => {
  await withRejectionSentinel(async () => {
    const server = createNodeHttpServer({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new Error("stream failed"));
            },
          }),
        ),
    });
    const port = await listen(server);
    try {
      await fetch(`http://127.0.0.1:${port}/stream`)
        .then((response) => response.text())
        .catch(() => undefined);
    } finally {
      await close(server);
    }
  });
});

test("the server declares explicit connection budgets", () => {
  const server = createNodeHttpServer({ fetch: async () => new Response("ok") });
  assert.equal(server.headersTimeout, 20_000);
  assert.equal(server.requestTimeout, 60_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.maxHeadersCount, 200);
});
