import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { defineServerService, zelavisServer } from "../dist/index.js";
import { expressAdapter } from "../dist/adapters/express.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test("expressAdapter preserves binary bodies, repeated headers, and HEAD fallback", async () => {
  const app = express();

  app.use(express.json());

  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.binary",
              method: "POST",
              path: "/binary",
              handler: ({ body }) => ({
                headers: new Headers([
                  ["content-type", "application/octet-stream"],
                  ["set-cookie", "a=1; Path=/"],
                  ["set-cookie", "b=2; Path=/"],
                ]),
                body,
              }),
            },
            {
              id: "demo.head",
              method: "GET",
              path: "/head",
              handler: () => ({
                headers: {
                  "x-head": "ok",
                },
                body: "visible-on-get",
              }),
            },
          ],
        },
      }),
    ],
  });

  app.use(expressAdapter(runtime));

  const server = app.listen(0, "127.0.0.1");
  const baseUrl = await new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const binaryResponse = await fetch(`${baseUrl}/demo/binary`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array([5, 6, 7]),
    });

    assert.deepEqual(
      new Uint8Array(await binaryResponse.arrayBuffer()),
      new Uint8Array([5, 6, 7]),
    );
    assert.deepEqual(binaryResponse.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; Path=/",
    ]);

    const headResponse = await fetch(`${baseUrl}/demo/head`, {
      method: "HEAD",
    });

    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("x-head"), "ok");
    assert.equal(await headResponse.text(), "");
  } finally {
    await close(server);
  }
});
