import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";

const run = promisify(execFile);
const DAY = 86_400_000;

test("the certificate parses and carries the names, validity and key usage it was given", () => {
  const now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const { certPem, notBefore, notAfter } = generateAgentCertificate({ names: ["203.0.113.7", "worker.example.com", "2001:db8::1"], validityDays: 100, now });
  const cert = new X509Certificate(certPem);
  assert.equal(cert.ca, true, "a self-signed root, like `openssl req -x509`");
  assert.equal(cert.subject, "CN=zelavis-agent");
  assert.equal(cert.issuer, cert.subject, "self-signed");
  assert.equal(cert.subjectAltName, "IP Address:203.0.113.7, DNS:worker.example.com, IP Address:2001:DB8:0:0:0:0:0:1");
  assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  assert.equal(cert.publicKey.asymmetricKeyType, "ec");
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.equal(Date.parse(cert.validFrom), notBefore);
  assert.equal(Date.parse(cert.validTo), notAfter);
  assert.equal(notAfter - notBefore, 101 * DAY, "100 days plus the one-day backdate");
  assert.ok(cert.checkIssued(cert), "its own signature verifies");
});

test("openssl, an independent implementation, accepts the encoding and the signature", async () => {
  const { certPem } = generateAgentCertificate({ names: ["127.0.0.1", "localhost"] });
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cert-"));
  const file = join(directory, "agent.crt");
  await writeFile(file, certPem);
  const parsed = await run("openssl", ["x509", "-in", file, "-noout", "-text"]);
  assert.match(parsed.stdout, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(parsed.stdout, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(parsed.stdout, /Certificate Sign/);
  assert.match(parsed.stdout, /Digital Signature/);
  assert.match(parsed.stdout, /TLS Web Server Authentication/);
  assert.match(parsed.stdout, /IP Address:127\.0\.0\.1/);
  assert.match(parsed.stdout, /DNS:localhost/);
  const verified = await run("openssl", ["verify", "-CAfile", file, file]);
  assert.match(verified.stdout, /OK/);
});

async function handshake({ names, dial, certNames = names }) {
  const { keyPem, certPem } = generateAgentCertificate({ names: certNames });
  const server = createServer({ key: keyPem, cert: certPem }, (_request, response) => response.end("agent"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await new Promise((resolve) => {
      const call = request({ hostname: dial, port: server.address().port, path: "/", ca: certPem, rejectUnauthorized: true, servername: dial.match(/^[\d.:]+$/) ? undefined : dial }, (response) => {
        response.resume();
        response.on("end", () => resolve({ ok: true }));
      });
      call.once("error", (error) => resolve({ ok: false, code: error.code }));
      call.end();
    });
  } finally {
    server.close();
  }
}

test("a real TLS client that pins it as the CA and verifies hostnames accepts the Agent by IP", async () => {
  assert.deepEqual(await handshake({ names: ["127.0.0.1"], dial: "127.0.0.1" }), { ok: true });
});

test("and by hostname", async () => {
  assert.deepEqual(await handshake({ names: ["localhost"], dial: "localhost" }), { ok: true });
});

test("a name that is not in the certificate is refused", async () => {
  const result = await handshake({ names: ["localhost"], dial: "127.0.0.1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ERR_TLS_CERT_ALTNAME_INVALID");
});

test("another Agent's certificate is not accepted as this Agent's", async () => {
  const mine = generateAgentCertificate({ names: ["127.0.0.1"] });
  const theirs = generateAgentCertificate({ names: ["127.0.0.1"] });
  const server = createServer({ key: theirs.keyPem, cert: theirs.certPem }, (_request, response) => response.end("x"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const outcome = await new Promise((resolve) => {
      const call = request({ hostname: "127.0.0.1", port: server.address().port, ca: mine.certPem, rejectUnauthorized: true }, () => resolve({ ok: true }));
      call.once("error", (error) => resolve({ ok: false, code: error.code }));
      call.end();
    });
    assert.equal(outcome.ok, false);
  } finally {
    server.close();
  }
});

test("each certificate has its own key and a positive, non-zero serial", () => {
  const first = generateAgentCertificate({ names: ["127.0.0.1"] });
  const second = generateAgentCertificate({ names: ["127.0.0.1"] });
  assert.notEqual(first.keyPem, second.keyPem);
  for (const { certPem } of [first, second]) {
    const serial = new X509Certificate(certPem).serialNumber;
    assert.match(serial, /^[0-9A-F]+$/);
    assert.ok(!/^0+$/.test(serial));
    assert.ok(parseInt(serial.slice(0, 2), 16) < 0x80, "the top bit is clear, so the DER integer is positive");
  }
});

test("names are validated before anything is encoded", () => {
  for (const names of [[], Array(9).fill("a.example"), ["bad name"], ["-lead.example"], ["a..b"], ["x".repeat(254)], [""], ["a_b.example"], ["http://x"]]) {
    assert.throws(() => generateAgentCertificate({ names }), TypeError, JSON.stringify(names).slice(0, 40));
  }
  assert.throws(() => generateAgentCertificate({ names: ["a.example"], validityDays: 0 }), RangeError);
  assert.throws(() => generateAgentCertificate({ names: ["a.example"], validityDays: 1.5 }), RangeError);
  assert.throws(() => generateAgentCertificate({ names: ["a.example"], validityDays: 4000 }), RangeError);
  assert.throws(() => generateAgentCertificate({ names: ["a.example"], validityDays: 3650, now: Date.UTC(2045, 0, 1) }), RangeError, "UTCTime ends in 2049");
});

test("duplicate names are collapsed", () => {
  const cert = new X509Certificate(generateAgentCertificate({ names: ["a.example", "a.example", "10.0.0.1", "10.0.0.1"] }).certPem);
  assert.equal(cert.subjectAltName, "DNS:a.example, IP Address:10.0.0.1");
});
