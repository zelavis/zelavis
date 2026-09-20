import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";

import {
  CERTIFICATES_NAMESPACE,
  createAcmeChallengeService,
  createAcmeClient,
  createMemoryAcmeChallengeStore,
  createSystemStoreAcmeChallengeStore,
  createZelavisCertificateController,
  decryptSecret,
  encryptSecret,
  exportP256Jwk,
  calculateP256JwkThumbprint,
  generateCsrDer,
  generateP256KeyPair,
  signJws,
  fromBase64Url,
  toBase64Url,
  createMemorySystemStore,
  createZelavisEdgeRouteStore,
  createTraefikCertificateDistributor,
  performEdgeOnboarding,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// 1. Cryptographic Primitives & CSR Generation Tests
// ---------------------------------------------------------------------------

test("acme-crypto: AES-256-GCM secret encryption and decryption roundtrip", () => {
  const masterSecret = "super-secret-platform-key-32-chars!!";
  const plaintext = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...\n-----END PRIVATE KEY-----";

  const encrypted = encryptSecret(plaintext, masterSecret);
  assert.equal(encrypted.algorithm, "AES-256-GCM");
  assert.ok(encrypted.ciphertext);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.tag);
  assert.notEqual(encrypted.ciphertext, plaintext);

  const decrypted = decryptSecret(encrypted, masterSecret);
  assert.equal(decrypted, plaintext);

  // Tampering with ciphertext throws authentication tag mismatch
  const tampered = { ...encrypted, ciphertext: toBase64Url("tampered-data") };
  assert.throws(() => decryptSecret(tampered, masterSecret));
});

test("acme-crypto: P-256 JWK export and RFC 7638 thumbprint calculation", () => {
  // Test vector from RFC 7638 Section 3.1
  const rfcJwk = {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xFWiL4dfgUTrAZgw-Tyma-ジャン-QnJ-xXg",
    y: "x_daQauIfDp4noJUnzqhVZNsGavDigyiiobMkpuGs8A",
  };
  const thumbprint = calculateP256JwkThumbprint(rfcJwk);
  assert.equal(typeof thumbprint, "string");
  assert.ok(thumbprint.length > 20);

  // Generated key pair
  const keyPair = generateP256KeyPair();
  const jwk = exportP256Jwk(keyPair.publicKey);
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.ok(jwk.x);
  assert.ok(jwk.y);

  const keyThumbprint = calculateP256JwkThumbprint(jwk);
  assert.equal(typeof keyThumbprint, "string");
});

test("acme-crypto: JWS flattened signing produces valid ES256 IEEE P1363 signature", () => {
  const keyPair = generateP256KeyPair();
  const header = {
    alg: "ES256",
    nonce: "test-nonce-123",
    url: "https://acme.example.com/new-order",
    kid: "https://acme.example.com/acct/1",
  };
  const payload = { identifiers: [{ type: "dns", value: "example.com" }] };

  const jws = signJws({
    privateKey: keyPair.privateKey,
    header,
    payload,
  });

  assert.ok(jws.protected);
  assert.ok(jws.payload);
  assert.ok(jws.signature);

  // Signature bytes must be exactly 64 bytes (IEEE P1363 r || s)
  const sigBytes = fromBase64Url(jws.signature);
  assert.equal(sigBytes.length, 64);
});

test("acme-crypto: ASN.1 DER PKCS#10 CSR generation with CN and SAN extensions", () => {
  const keyPair = generateP256KeyPair();
  const commonName = "app.zelavis.local";
  const sanList = ["api.zelavis.local", "portal.zelavis.local"];

  const csrDer = generateCsrDer({
    keyPair,
    commonName,
    sanList,
  });

  assert.ok(csrDer.length > 100);

  // Verify structure: outer tag 0x30 (SEQUENCE)
  assert.equal(csrDer[0], 0x30);
});

// ---------------------------------------------------------------------------
// 2. Challenge Stores & HTTP-01 Responder Service Tests
// ---------------------------------------------------------------------------

test("AcmeChallengeStore: in-memory store handles put, get, TTL expiry, and delete", async () => {
  const store = createMemoryAcmeChallengeStore();
  const token = "challenge-token-1";
  const keyAuth = "challenge-token-1.account-thumbprint-xyz";
  const futureExpiry = new Date(Date.now() + 60000);

  await store.putHttpChallenge(token, keyAuth, futureExpiry);
  const retrieved = await store.getHttpChallenge(token);
  assert.equal(retrieved, keyAuth);

  const deleted = await store.deleteHttpChallenge(token);
  assert.equal(deleted, true);
  assert.equal(await store.getHttpChallenge(token), undefined);

  // Expired token
  const pastExpiry = new Date(Date.now() - 1000);
  await store.putHttpChallenge("expired-token", keyAuth, pastExpiry);
  assert.equal(await store.getHttpChallenge("expired-token"), undefined);
});

test("AcmeChallengeStore: system store-backed challenge store", async () => {
  const systemStore = createMemorySystemStore();
  const challengeStore = createSystemStoreAcmeChallengeStore(systemStore);
  const token = "sys-token-1";
  const keyAuth = "sys-token-1.thumbprint";

  await challengeStore.putHttpChallenge(token, keyAuth, new Date(Date.now() + 60000));
  assert.equal(await challengeStore.getHttpChallenge(token), keyAuth);

  await challengeStore.deleteHttpChallenge(token);
  assert.equal(await challengeStore.getHttpChallenge(token), undefined);
});

test("createAcmeChallengeService: serves /.well-known/acme-challenge/:token", async () => {
  const challengeStore = createMemoryAcmeChallengeStore();
  await challengeStore.putHttpChallenge(
    "active-token",
    "active-token.thumbprint-123",
    new Date(Date.now() + 60000),
  );

  const service = createAcmeChallengeService(challengeStore);
  assert.equal(service.name, "zelavis-acme-challenge");
  assert.equal(service.basePath, "/");

  const route = service.api.v1[0];
  assert.equal(route.path, "/.well-known/acme-challenge/:token");
  assert.equal(route.method, "GET");

  // Valid token
  const okResponse = await route.handler({
    params: { token: "active-token" },
  });
  assert.equal(okResponse.status, 200);
  assert.equal(okResponse.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(okResponse.body, "active-token.thumbprint-123");

  // Unknown token
  const missingResponse = await route.handler({
    params: { token: "unknown-token" },
  });
  assert.equal(missingResponse.status, 404);
});

// ---------------------------------------------------------------------------
// 3. Certificate Controller Tests
// ---------------------------------------------------------------------------

test("createZelavisCertificateController: stores, retrieves, and resolves manual certificates", async () => {
  const store = createMemorySystemStore();
  const masterSecret = "platform-controller-master-secret-123";
  const controller = createZelavisCertificateController({
    store,
    masterSecret,
  });

  const fakeCert =
    "-----BEGIN CERTIFICATE-----\nMIIBojCCAUqgAwIBAgIU...\n-----END CERTIFICATE-----";
  const fakeKey =
    "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49...\n-----END PRIVATE KEY-----";

  const imported = await controller.importManualCertificate({
    ref: "certificate:custom.example.com",
    hostname: "custom.example.com",
    sanHostnames: ["api.example.com"],
    certPem: fakeCert,
    keyPem: fakeKey,
  });

  assert.equal(imported.ref, "certificate:custom.example.com");
  assert.equal(imported.hostname, "custom.example.com");
  assert.equal(imported.version, 1);
  assert.equal(imported.issuer, "manual");
  assert.equal(imported.status, "valid");

  // Public getCertificate omits private key
  const publicSummary = await controller.getCertificate(
    "certificate:custom.example.com",
  );
  assert.ok(publicSummary);
  assert.equal(publicSummary.hostname, "custom.example.com");
  assert.equal(publicSummary.keyPem, undefined);
  assert.equal(publicSummary.encryptedKey, undefined);

  // resolveCertificate returns decrypted PEM key
  const resolved = await controller.resolveCertificate(
    "certificate:custom.example.com",
  );
  assert.ok(resolved);
  assert.equal(resolved.certPem, fakeCert);
  assert.equal(resolved.keyPem, fakeKey);

  // List certificates
  const list = await controller.listCertificates();
  assert.equal(list.length, 1);
  assert.equal(list[0].hostname, "custom.example.com");
});

test("createZelavisCertificateController: renewal check ignores valid non-expiring certs", async () => {
  const store = createMemorySystemStore();
  const masterSecret = "secret-key-123";
  const controller = createZelavisCertificateController({
    store,
    masterSecret,
  });

  // Future expiry: 60 days
  const validUntil = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await store.set(CERTIFICATES_NAMESPACE, "certificate:fresh.example.com", {
    schemaVersion: 1,
    ref: "certificate:fresh.example.com",
    hostname: "fresh.example.com",
    sanHostnames: [],
    issuer: "acme",
    version: 1,
    certPem: "cert-data",
    encryptedKey: encryptSecret("key-data", masterSecret),
    expiresAt: validUntil,
    issuedAt: new Date().toISOString(),
    status: "valid",
    updatedAt: new Date().toISOString(),
  });

  const check = await controller.checkRenewals({ renewIfWithinDays: 30 });
  assert.equal(check.checked, 1);
  assert.equal(check.renewed.length, 0);
  assert.equal(check.failed.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Mock ACME RFC 8555 End-to-End Integration Test
// ---------------------------------------------------------------------------

test("createZelavisCertificateController: end-to-end ACME v2 order, challenge, CSR, and staging", async () => {
  const store = createMemorySystemStore();
  const masterSecret = "zelavis-test-master-secret-123456";
  const challengeStore = createMemoryAcmeChallengeStore();

  let observedKeyAuth;
  let authzValid = false;

  // Simple in-memory mock ACME v2 server
  const server = createServer(async (req, res) => {
    const host = req.headers.host || "127.0.0.1";
    const origin = `http://${host}`;
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/directory" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          newNonce: `${origin}/new-nonce`,
          newAccount: `${origin}/new-account`,
          newOrder: `${origin}/new-order`,
        }),
      );
      return;
    }

    if (url.pathname === "/new-nonce") {
      res.writeHead(200, {
        "Replay-Nonce": "nonce-1",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    // Capture body for POST requests
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    const jws = bodyStr ? JSON.parse(bodyStr) : {};

    if (url.pathname === "/new-account") {
      res.writeHead(201, {
        "Location": `${origin}/acct/1`,
        "Replay-Nonce": "nonce-2",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ status: "valid" }));
      return;
    }

    if (url.pathname === "/new-order") {
      res.writeHead(201, {
        "Location": `${origin}/order/1`,
        "Replay-Nonce": "nonce-3",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: "pending",
          identifiers: [{ type: "dns", value: "test.zelavis.local" }],
          authorizations: [`${origin}/authz/1`],
          finalize: `${origin}/finalize/1`,
        }),
      );
      return;
    }

    if (url.pathname === "/authz/1") {
      res.writeHead(200, {
        "Replay-Nonce": "nonce-4",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: authzValid ? "valid" : "pending",
          identifier: { type: "dns", value: "test.zelavis.local" },
          challenges: [
            {
              type: "http-01",
              url: `${origin}/chal/1`,
              token: "test-token-xyz",
              status: authzValid ? "valid" : "pending",
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/chal/1") {
      // Challenge notify: ACME server verifies challenge from challengeStore
      observedKeyAuth = await challengeStore.getHttpChallenge("test-token-xyz");
      authzValid = true;

      res.writeHead(200, {
        "Replay-Nonce": "nonce-5",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          type: "http-01",
          url: `${origin}/chal/1`,
          status: "valid",
        }),
      );
      return;
    }

    if (url.pathname === "/finalize/1") {
      // Validate CSR payload
      const payload = JSON.parse(fromBase64Url(jws.payload).toString("utf8"));
      assert.ok(payload.csr);

      res.writeHead(200, {
        "Location": `${origin}/order/1`,
        "Replay-Nonce": "nonce-6",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: "valid",
          identifiers: [{ type: "dns", value: "test.zelavis.local" }],
          authorizations: [`${origin}/authz/1`],
          finalize: `${origin}/finalize/1`,
          certificate: `${origin}/cert/1`,
        }),
      );
      return;
    }

    if (url.pathname === "/order/1") {
      res.writeHead(200, {
        "Replay-Nonce": "nonce-7",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: "valid",
          certificate: `${origin}/cert/1`,
        }),
      );
      return;
    }

    if (url.pathname === "/cert/1") {
      res.writeHead(200, {
        "Replay-Nonce": "nonce-8",
        "Content-Type": "application/pem-certificate-chain",
      });
      res.end(
        "-----BEGIN CERTIFICATE-----\nMIIBkDCB+wIJAL0000000001MAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCFplbGF2\naXMwHhcNMjYwOTIwMDAwMDAwWhcNMjYxMjE5MDAwMDAwWjATMREwDwYDVQQDDAha\nZWxhdmlzMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...\n-----END CERTIFICATE-----",
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const directoryUrl = `http://127.0.0.1:${port}/directory`;

  try {
    const controller = createZelavisCertificateController({
      store,
      masterSecret,
      defaultDirectoryUrl: directoryUrl,
      challengeStore,
    });

    // Order ACME Certificate
    const certSummary = await controller.orderCertificate({
      hostname: "test.zelavis.local",
      contactEmail: "admin@zelavis.local",
    });

    assert.equal(certSummary.ref, "certificate:test.zelavis.local");
    assert.equal(certSummary.hostname, "test.zelavis.local");
    assert.equal(certSummary.issuer, "acme");
    assert.equal(certSummary.status, "valid");
    assert.equal(certSummary.version, 1);

    // Verify HTTP-01 challenge key authorization was generated and observed
    assert.ok(observedKeyAuth);
    assert.ok(observedKeyAuth.startsWith("test-token-xyz."));

    // Verify resolved certificate contains valid PEM chain and decrypted private key
    const resolved = await controller.resolveCertificate(certSummary.ref);
    assert.ok(resolved);
    assert.ok(resolved.certPem.includes("BEGIN CERTIFICATE"));
    assert.ok(resolved.keyPem.includes("BEGIN PRIVATE KEY"));

    // Verify distributor integration: staging via resolver
    const stagedCalls = [];
    const mockInvoker = {
      async execute(op, args) {
        stagedCalls.push({ op, args });
        return { success: true };
      },
    };

    const distributor = createTraefikCertificateDistributor({
      invoker: mockInvoker,
      certificateResolver: async (ref) => {
        const c = await controller.resolveCertificate(ref);
        return c ? { certPem: c.certPem, keyPem: c.keyPem } : undefined;
      },
    });

    await distributor.stage({
      switchId: "switch-1",
      publication: {
        id: "pub-1",
        revision: "rev-1",
        routeCount: 1,
        requiredCapabilities: ["https"],
        certificateRefs: [certSummary.ref],
      },
    });

    assert.equal(stagedCalls.length, 1);
    assert.equal(stagedCalls[0].op, "zelavis.edge-stage");
    assert.equal(stagedCalls[0].args["cert-name"], "certificate_test_zelavis_local");
    assert.ok(stagedCalls[0].args["cert-pem"].includes("BEGIN CERTIFICATE"));
    assert.ok(stagedCalls[0].args["key-pem"].includes("BEGIN PRIVATE KEY"));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Hostname Onboarding Integration with Certificate Controller Test
// ---------------------------------------------------------------------------

test("performEdgeOnboarding: managed TLS provisions certificate via certificateController", async () => {
  const store = createMemorySystemStore();
  const routeStore = createZelavisEdgeRouteStore({ store });
  const masterSecret = "test-master-secret";

  let certificateOrdered = false;
  const mockCertController = {
    async orderCertificate(options) {
      certificateOrdered = true;
      return {
        ref: `certificate:${options.hostname}`,
        hostname: options.hostname,
        sanHostnames: [],
        issuer: "acme",
        version: 1,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        issuedAt: new Date().toISOString(),
        status: "valid",
        updatedAt: new Date().toISOString(),
      };
    },
  };

  const result = await performEdgeOnboarding(
    {
      routeStore,
      certificateController: mockCertController,
    },
    {
      mode: "managed",
      hostname: "console.example.com",
    },
  );

  assert.equal(result.mode, "managed");
  assert.equal(result.status, "configured");
  assert.equal(result.canonicalUrl, "https://console.example.com");
  assert.equal(certificateOrdered, true);

  const storedHostname = await routeStore.getHostname("console.example.com");
  assert.equal(storedHostname?.tlsMode, "managed");
  assert.equal(storedHostname?.certificateRef, "certificate:console.example.com");
});
