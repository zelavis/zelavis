import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { makeShardHttp } from "../dist/db/engines/remote-shard-http.js";

const run = promisify(execFile);

test("a call to a silent Agent fails at its deadline even while it waits for a pooled socket", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zv-shard-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [key, cert] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  // Accepts every connection and every request, and never answers: what a silent Agent looks like from here.
  const held = new Set();
  const server = createServer({ key, cert }, (request, response) => { held.add(response); });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  t.after(() => new Promise((resolve) => { for (const response of held) response.destroy(); server.closeAllConnections(); server.close(resolve); }));
  const timeout = 1_000;
  const http = makeShardHttp({ url: `https://localhost:${server.address().port}`, caPem: cert }, "/v1/shards/kv", timeout);
  t.after(() => Effect.runPromise(http.close));
  // Seventeen at once: one more than the pool holds, so the last waits for a socket that no answer ever frees.
  const started = Date.now();
  const outcomes = await Effect.runPromise(Effect.forEach(Array.from({ length: 17 }, (_, index) => index), (index) =>
    http.post("get", JSON.stringify({ op: "get", index })).pipe(
      Effect.flip,
      Effect.map((error) => ({ error, millis: Date.now() - started }))), { concurrency: 17 }));
  for (const { error, millis } of outcomes) {
    assert.equal(error._tag, "StoreError");
    assert.match(String(error.cause), /timed out/);
    assert.ok(millis < timeout * 1.7, `a call waited ${millis} ms against a ${timeout} ms deadline`);
  }
});
