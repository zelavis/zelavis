// Storage quotas and signed direct uploads: every write is held to the quota, an upload link's terms cannot be
// changed by whoever holds it, its bytes wait in staging until an authorized caller confirms them, and what is
// never confirmed is cleaned up.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";
import { resolveStorageEndpointGroup } from "../dist/platform/storage.js";

const setup = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-uploads-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = createLocalFileStorage(dir);
  const group = await resolveStorageEndpointGroup({ storage }, { rootPath: "/zelavis", apiPrefix: "/zelavis/api", apiVersion: "v1" });
  const route = (id) => group.api.v1.find((entry) => entry.id === id);
  const call = async (id, input = {}) => {
    const answer = await route(id).handler({ params: input.params ?? {}, body: input.body, query: new URLSearchParams(), request: input.bytes ? new Request("http://x", { method: "PUT", body: input.bytes }) : undefined, requestHeaders: new Headers(input.headers ?? {}) });
    return answer;
  };
  return { storage, call };
};
const bytes = (text) => new TextEncoder().encode(text);

test("every write is held to the quota, and the reserved prefix is refused", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("storage.quota.set", { body: { maxBytes: 10, maxFileBytes: 6 } })).status, 200);
  assert.equal((await call("storage.files.write", { params: { path: "a.txt" }, bytes: bytes("12345") })).status, 200);
  const tooBig = await call("storage.files.write", { params: { path: "b.txt" }, bytes: bytes("1234567") });
  assert.match(tooBig.body.error, /at most 6 bytes/);
  const full = await call("storage.files.write", { params: { path: "c.txt" }, bytes: bytes("123456") });
  assert.match(full.body.error, /may hold 10 bytes/);
  assert.equal((await call("storage.files.write", { params: { path: "a.txt" }, bytes: bytes("123456") })).status, 200, "replacing a file counts only the difference");
  const usage = (await call("storage.quota.get")).body;
  assert.deepEqual(usage, { quota: { maxBytes: 10, maxFileBytes: 6 }, usage: { bytes: 6, files: 1 } });
  assert.match((await call("storage.files.write", { params: { path: ".zelavis/quota.json" }, bytes: bytes("{}") })).body.error, /reserved/);
  assert.match((await call("storage.files.read", { params: { path: ".zelavis/upload-key" } })).body.error, /reserved/);
  assert.ok(!(await call("storage.files.list")).body.files.some((file) => file.path.startsWith(".zelavis")), "the storage's own state is not listed");
});

test("a signed upload is single use, bound to its terms, staged until confirmed, and cleaned up when abandoned", async (t) => {
  const { storage, call } = await setup(t);
  const upload = (await call("storage.uploads.create", { body: { path: "avatars/ada.png", maxBytes: 8, contentType: "image/png", expiresInSeconds: 60 } })).body;
  assert.match(upload.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const send = (token, data, type = "image/png") => call("storage.uploads.receive", { params: { token }, bytes: bytes(data), headers: { "content-type": type } });
  assert.match((await send(upload.token, "123456789")).body.error, /at most 8 bytes/);
  assert.match((await send(upload.token, "1234", "text/plain")).body.error, /must be image\/png/);
  const [payload, signature] = upload.token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), maxBytes: 999999 })).toString("base64url");
  assert.match((await send(`${forged}.${signature}`, "1234")).body.error, /not valid/, "changing the terms breaks the signature");
  const received = (await send(upload.token, "1234")).body;
  assert.equal(received.size, 4);
  assert.match(received.sha256, /^[0-9a-f]{64}$/);
  assert.match((await send(upload.token, "1234")).body.error, /has been used/);
  assert.equal(await storage.get("avatars/ada.png"), undefined, "staged, not yet a file");
  assert.match((await call("storage.uploads.confirm", { params: { id: upload.id }, body: { sha256: "0".repeat(64) } })).body.error, /not the expected file/);
  const confirmed = (await call("storage.uploads.confirm", { params: { id: upload.id }, body: { sha256: received.sha256, size: 4 } })).body;
  assert.equal(confirmed.path, "avatars/ada.png");
  assert.equal(new TextDecoder().decode((await storage.get("avatars/ada.png")).body), "1234");

  const abandoned = (await call("storage.uploads.create", { body: { path: "x.bin", maxBytes: 4, expiresInSeconds: 1 } })).body;
  await send(abandoned.token, "ab", "application/octet-stream");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match((await send(abandoned.token, "ab")).body.error, /expired|used/);
  assert.deepEqual((await call("storage.uploads.cleanup")).body, { removed: 1 });
  assert.match((await call("storage.uploads.confirm", { params: { id: abandoned.id } })).body.error, /No upload/);
});
