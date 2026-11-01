import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import test from "node:test";

import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { createPinnedFetch, normalizeFingerprint } from "../dist/adapters/_pinned-fetch.js";

async function peer(handler) {
  const { keyPem, certPem } = generateAgentCertificate({ names: ["127.0.0.1"] });
  const seen = { requests: 0, bodies: [] };
  const server = createServer({ key: keyPem, cert: certPem }, (request, response) => {
    seen.requests++;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => { seen.bodies.push(Buffer.concat(chunks).toString()); handler(request, response); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}`, certPem, seen,
    fingerprint: new X509Certificate(certPem).fingerprint256,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
const ok = (_request, response) => response.end("fine");

test("a matching pin is accepted, in any common spelling, and the request arrives intact", async (t) => {
  const subject = await peer((request, response) => response.end(`${request.method} ${request.url} ${request.headers["x-probe"]}`));
  t.after(subject.close);
  const hex = subject.fingerprint.replaceAll(":", "");
  for (const spelling of [subject.fingerprint, `sha256:${hex.toLowerCase()}`, hex, `SHA256:${subject.fingerprint.toLowerCase()}`.replace("SHA256", "sha256")]) {
    const response = await createPinnedFetch({ fingerprint: spelling })(`${subject.url}/a/b?c=d`, { method: "POST", headers: { "x-probe": "1" }, body: "payload" });
    assert.equal(response.status, 200, spelling);
    assert.equal(await response.text(), "POST /a/b?c=d 1");
  }
  assert.ok(subject.seen.bodies.every((body) => body === "payload"));
});

test("a wrong pin sends nothing: not the request line, not the body", async (t) => {
  const subject = await peer(ok);
  t.after(subject.close);
  const wrong = "ab".repeat(32);
  await assert.rejects(() => createPinnedFetch({ fingerprint: wrong })(`${subject.url}/secret`, { method: "POST", body: "TOKEN-123" }),
    /does not match the pinned fingerprint/);
  assert.equal(subject.seen.requests, 0, "the peer never saw a request");
});

test("a pin is a certificate, not a name: another peer presenting a valid-looking certificate is refused", async (t) => {
  const real = await peer(ok);
  const lookalike = await peer(ok);
  t.after(real.close);
  t.after(lookalike.close);
  assert.equal((await createPinnedFetch({ fingerprint: real.fingerprint })(real.url)).status, 200);
  await assert.rejects(() => createPinnedFetch({ fingerprint: real.fingerprint })(lookalike.url), /does not match/);
  assert.equal(lookalike.seen.requests, 0);
});

test("without a pin or a CA, a self-signed peer is refused and sent nothing", async (t) => {
  const subject = await peer(ok);
  t.after(subject.close);
  await assert.rejects(() => createPinnedFetch({})(subject.url, { method: "POST", body: "TOKEN" }));
  assert.equal(subject.seen.requests, 0);
});

test("a CA bundle is honoured, and only that bundle", async (t) => {
  const subject = await peer(ok);
  const stranger = generateAgentCertificate({ names: ["127.0.0.1"] }).certPem;
  t.after(subject.close);
  assert.equal((await createPinnedFetch({ caPem: subject.certPem })(subject.url)).status, 200);
  await assert.rejects(() => createPinnedFetch({ caPem: stranger })(subject.url));
});

test("plain http and embedded credentials are refused without a connection", async () => {
  const fetchOver = createPinnedFetch({});
  await assert.rejects(() => fetchOver("http://127.0.0.1:1/"), /over https/);
  await assert.rejects(() => fetchOver("https://user:pw@127.0.0.1:1/"), /credentials/i);
});

test("a redirect is returned, never followed, so a credential cannot be carried elsewhere", async (t) => {
  const elsewhere = await peer(ok);
  const subject = await peer((_request, response) => { response.writeHead(302, { location: `${elsewhere.url}/stolen` }); response.end(); });
  t.after(subject.close);
  t.after(elsewhere.close);
  const response = await createPinnedFetch({ caPem: subject.certPem })(subject.url, { method: "POST", body: "TOKEN", redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(elsewhere.seen.requests, 0);
});

test("an oversized response is cut off rather than buffered", async (t) => {
  const subject = await peer((_request, response) => { response.write(Buffer.alloc(2 * 1024 * 1024, 120)); response.end(); });
  t.after(subject.close);
  await assert.rejects(() => createPinnedFetch({ caPem: subject.certPem })(subject.url).then((r) => r.text()), /exceeded the limit|socket hang up|aborted/);
});

test("an aborted request is abandoned", async (t) => {
  const subject = await peer(() => {});
  t.after(subject.close);
  const controller = new AbortController();
  const pending = createPinnedFetch({ caPem: subject.certPem })(subject.url, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => pending, /abort/i);
  await assert.rejects(() => createPinnedFetch({ caPem: subject.certPem })(subject.url, { signal: AbortSignal.abort() }), /abort/i);
});

test("the options are validated up front", () => {
  assert.throws(() => createPinnedFetch({ fingerprint: "x".repeat(64) }), /SHA-256/);
  assert.throws(() => createPinnedFetch({ fingerprint: "ab".repeat(31) }), /SHA-256/);
  assert.throws(() => createPinnedFetch({ fingerprint: "ab".repeat(32), caPem: "pem" }), /not both/);
  assert.equal(normalizeFingerprint("SHA256:" + "AB:".repeat(31) + "AB"), "ab".repeat(32));
  assert.equal(normalizeFingerprint("nope"), undefined);
});
