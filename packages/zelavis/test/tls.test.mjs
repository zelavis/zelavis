import assert from "node:assert/strict";
import test from "node:test";
import {
  chainTlsProviders,
  createExternalTlsProvider,
  createManualTlsProvider,
} from "../dist/index.js";

const FAKE_CERT = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----";
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----";

// ---------- External no-op ----------

test("createExternalTlsProvider returns undefined for every hostname", async () => {
  const provider = createExternalTlsProvider();
  assert.equal(provider.name, "external");
  assert.equal(await provider.getCertificate("example.com"), undefined);
  assert.equal(await provider.getCertificate("anything.else"), undefined);
  assert.deepEqual(await provider.listHostnames(), []);
});

// ---------- Manual provider ----------

test("createManualTlsProvider returns the exact-match certificate", async () => {
  const provider = createManualTlsProvider({
    certificates: {
      "acme.com": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });

  const cert = await provider.getCertificate("acme.com");
  assert.ok(cert);
  assert.equal(cert.cert, FAKE_CERT);
  assert.equal(cert.key, FAKE_KEY);

  const miss = await provider.getCertificate("other.com");
  assert.equal(miss, undefined);
});

test("createManualTlsProvider is case-insensitive on hostname lookup", async () => {
  const provider = createManualTlsProvider({
    certificates: {
      "ACME.com": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });

  const a = await provider.getCertificate("acme.com");
  const b = await provider.getCertificate("ACME.COM");
  const c = await provider.getCertificate("Acme.Com");
  assert.ok(a && b && c);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('createManualTlsProvider falls back to the "*" default cert', async () => {
  const explicit = { cert: FAKE_CERT, key: FAKE_KEY };
  const defaultCert = { cert: `${FAKE_CERT}-default`, key: `${FAKE_KEY}-default` };

  const provider = createManualTlsProvider({
    certificates: {
      "acme.com": explicit,
      "*": defaultCert,
    },
  });

  // Exact match wins
  assert.equal(await provider.getCertificate("acme.com"), explicit);
  // Anything else lands on the default
  assert.equal(await provider.getCertificate("other.com"), defaultCert);
  assert.equal(await provider.getCertificate("randomhost"), defaultCert);
});

test("createManualTlsProvider listHostnames excludes the wildcard sentinel", async () => {
  const provider = createManualTlsProvider({
    certificates: {
      "a.example.com": { cert: FAKE_CERT, key: FAKE_KEY },
      "b.example.com": { cert: FAKE_CERT, key: FAKE_KEY },
      "*": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });

  const hosts = await provider.listHostnames();
  assert.deepEqual(hosts.sort(), ["a.example.com", "b.example.com"]);
});

test("createManualTlsProvider validates cert + key are present and well-typed", () => {
  assert.throws(
    () => createManualTlsProvider({ certificates: { "x.com": null } }),
    /must be an object/,
  );
  assert.throws(
    () =>
      createManualTlsProvider({
        certificates: { "x.com": { cert: 42, key: FAKE_KEY } },
      }),
    /must include a string or Uint8Array `cert`/,
  );
  assert.throws(
    () =>
      createManualTlsProvider({
        certificates: { "x.com": { cert: FAKE_CERT, key: undefined } },
      }),
    /must include a string or Uint8Array `key`/,
  );
});

test("createManualTlsProvider accepts Uint8Array cert and key (for non-PEM-string callers)", async () => {
  const cert = new TextEncoder().encode(FAKE_CERT);
  const key = new TextEncoder().encode(FAKE_KEY);
  const provider = createManualTlsProvider({
    certificates: { "binary.example": { cert, key } },
  });

  const result = await provider.getCertificate("binary.example");
  assert.ok(result);
  assert.equal(result.cert, cert);
  assert.equal(result.key, key);
});

test("createManualTlsProvider snapshots the certificates map at construction", async () => {
  // Mutating the source after construction must not change provider behavior.
  const source = {
    certificates: {
      "a.com": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  };
  const provider = createManualTlsProvider(source);

  source.certificates["a.com"] = {
    cert: "tampered-cert",
    key: "tampered-key",
  };
  source.certificates["b.com"] = { cert: FAKE_CERT, key: FAKE_KEY };

  const a = await provider.getCertificate("a.com");
  assert.equal(a.cert, FAKE_CERT, "source mutation must not leak into provider");
  assert.equal(await provider.getCertificate("b.com"), undefined);
});

// ---------- chainTlsProviders ----------

test("chainTlsProviders returns the first provider that has a cert", async () => {
  const overrideCert = { cert: "override-cert", key: "override-key" };
  const fallbackCert = { cert: "fallback-cert", key: "fallback-key" };

  const override = createManualTlsProvider({
    certificates: { "special.example.com": overrideCert },
  });
  const fallback = createManualTlsProvider({
    certificates: {
      "special.example.com": fallbackCert,
      "general.example.com": fallbackCert,
    },
  });

  const chain = chainTlsProviders(override, fallback);

  // Override wins for special.example.com
  assert.equal(
    await chain.getCertificate("special.example.com"),
    overrideCert,
  );
  // Fallback handles hosts override doesn't know
  assert.equal(
    await chain.getCertificate("general.example.com"),
    fallbackCert,
  );
  // Neither has this one
  assert.equal(await chain.getCertificate("unknown.example.com"), undefined);
});

test("chainTlsProviders works with async providers", async () => {
  const slowCert = { cert: "slow-cert", key: "slow-key" };
  const slow = {
    name: "slow",
    async getCertificate(host) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return host === "delayed.example" ? slowCert : undefined;
    },
  };
  const fast = createManualTlsProvider({
    certificates: {
      "instant.example": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });

  const chain = chainTlsProviders(fast, slow);

  // Fast provider handles its hostname synchronously
  const instant = await chain.getCertificate("instant.example");
  assert.ok(instant);
  // Slow provider eventually returns for its hostname
  const delayed = await chain.getCertificate("delayed.example");
  assert.equal(delayed, slowCert);
});

test("chainTlsProviders listHostnames returns the deduped union of all providers", async () => {
  const a = createManualTlsProvider({
    certificates: {
      "alpha.example": { cert: FAKE_CERT, key: FAKE_KEY },
      "shared.example": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });
  const b = createManualTlsProvider({
    certificates: {
      "beta.example": { cert: FAKE_CERT, key: FAKE_KEY },
      "shared.example": { cert: FAKE_CERT, key: FAKE_KEY },
    },
  });

  const chain = chainTlsProviders(a, b);
  const hosts = await chain.listHostnames();
  assert.deepEqual(hosts, ["alpha.example", "beta.example", "shared.example"]);
});

test("chainTlsProviders name describes the composition", () => {
  const a = { name: "manual", getCertificate: () => undefined };
  const b = { name: "external", getCertificate: () => undefined };
  const chain = chainTlsProviders(a, b);
  assert.match(chain.name, /chain.*manual.*external/);
});

test("chainTlsProviders falls through to external no-op when nothing matches", async () => {
  const manual = createManualTlsProvider({
    certificates: { "a.com": { cert: FAKE_CERT, key: FAKE_KEY } },
  });
  const external = createExternalTlsProvider();
  const chain = chainTlsProviders(manual, external);

  // Manual handles its host
  assert.ok(await chain.getCertificate("a.com"));
  // Falls through to external (which returns undefined) for everything else —
  // documents the "TLS is terminated outside this process" intent.
  assert.equal(await chain.getCertificate("anything.else"), undefined);
});
