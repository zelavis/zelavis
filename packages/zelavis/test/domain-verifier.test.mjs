import assert from "node:assert/strict";
import test from "node:test";
import {
  addDomainBinding,
  createDomainChallengeService,
  createInMemoryDomainBindingStore,
  verifyDomainBindingViaDns,
  verifyDomainBindingViaHttp,
  zelavis,
} from "../dist/index.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

// ---------- DNS-TXT verifier ----------

function createMockResolver(records) {
  // records: Map<host, string[][]> — each host maps to an array of
  // TXT records, each record being an array of <=255-byte fragments.
  return {
    async resolveTxt(host) {
      if (!records.has(host)) {
        const err = new Error(`mock NXDOMAIN: ${host}`);
        err.code = "ENOTFOUND";
        throw err;
      }
      return records.get(host);
    },
  };
}

test("verifyDomainBindingViaDns flips verifiedAt when the TXT record matches", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const resolver = createMockResolver(
    new Map([["_zelavis-challenge.acme.com", [[binding.verificationToken]]]]),
  );

  const verified = await verifyDomainBindingViaDns(store, "acme.com", {
    resolver,
  });

  assert.ok(verified.verifiedAt);
  assert.equal(verified.verificationMethod, "dns-txt");

  // Persisted in the store
  const stored = await store.get("acme.com");
  assert.equal(stored.verifiedAt, verified.verifiedAt);
});

test("verifyDomainBindingViaDns concatenates multi-fragment TXT records (RFC 1035)", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  // Split the token across two fragments — a single TXT record may
  // contain multiple <=255-byte strings that should be joined.
  const split = [
    binding.verificationToken.slice(0, 10),
    binding.verificationToken.slice(10),
  ];
  const resolver = createMockResolver(
    new Map([["_zelavis-challenge.acme.com", [split]]]),
  );

  const verified = await verifyDomainBindingViaDns(store, "acme.com", {
    resolver,
  });
  assert.ok(verified.verifiedAt);
});

test("verifyDomainBindingViaDns picks the matching token out of multiple TXT records", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const resolver = createMockResolver(
    new Map([
      [
        "_zelavis-challenge.acme.com",
        [
          ["unrelated-google-verification=abc"],
          ["another-system-token=xyz"],
          [binding.verificationToken],
        ],
      ],
    ]),
  );

  const verified = await verifyDomainBindingViaDns(store, "acme.com", {
    resolver,
  });
  assert.ok(verified.verifiedAt);
});

test("verifyDomainBindingViaDns throws when no TXT records exist", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });
  const resolver = createMockResolver(new Map()); // NXDOMAIN

  await assert.rejects(
    () => verifyDomainBindingViaDns(store, "acme.com", { resolver }),
    /DNS-TXT lookup .* failed/,
  );
});

test("verifyDomainBindingViaDns throws when TXT records exist but none match", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });

  const resolver = createMockResolver(
    new Map([["_zelavis-challenge.acme.com", [["wrong-token"]]]]),
  );

  await assert.rejects(
    () => verifyDomainBindingViaDns(store, "acme.com", { resolver }),
    /did not include the expected token/,
  );
});

test("verifyDomainBindingViaDns throws when the binding doesn't exist", async () => {
  const store = createInMemoryDomainBindingStore();
  await assert.rejects(
    () =>
      verifyDomainBindingViaDns(store, "unknown.com", {
        resolver: createMockResolver(new Map()),
      }),
    /No domain binding exists/,
  );
});

test("verifyDomainBindingViaDns honors a custom challengePrefix", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const resolver = createMockResolver(
    new Map([["custom-challenge.acme.com", [[binding.verificationToken]]]]),
  );

  const verified = await verifyDomainBindingViaDns(store, "acme.com", {
    resolver,
    challengePrefix: "custom-challenge",
  });
  assert.ok(verified.verifiedAt);
});

// ---------- HTTP-01 verifier ----------

function createMockFetch(responseMap) {
  // responseMap: Map<url, { status?, body? }>
  return async (url) => {
    const entry = responseMap.get(url);
    if (!entry) {
      throw new Error(`mock fetch: no entry for ${url}`);
    }
    return new Response(entry.body ?? "", { status: entry.status ?? 200 });
  };
}

test("verifyDomainBindingViaHttp flips verifiedAt when the challenge response matches", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const expectedUrl = `http://acme.com/.well-known/zelavis-challenge/${binding.verificationToken}`;
  const fetch = createMockFetch(
    new Map([[expectedUrl, { status: 200, body: binding.verificationToken }]]),
  );

  const verified = await verifyDomainBindingViaHttp(store, "acme.com", {
    fetch,
  });

  assert.ok(verified.verifiedAt);
  assert.equal(verified.verificationMethod, "http-01");
});

test("verifyDomainBindingViaHttp trims trailing whitespace from the response body", async () => {
  // Some webservers append newlines to text files. Strict equality
  // would spuriously fail.
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const url = `http://acme.com/.well-known/zelavis-challenge/${binding.verificationToken}`;
  const fetch = createMockFetch(
    new Map([[url, { status: 200, body: `${binding.verificationToken}\n\n` }]]),
  );

  const verified = await verifyDomainBindingViaHttp(store, "acme.com", {
    fetch,
  });
  assert.ok(verified.verifiedAt);
});

test("verifyDomainBindingViaHttp throws on non-200 status", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const url = `http://acme.com/.well-known/zelavis-challenge/${binding.verificationToken}`;
  const fetch = createMockFetch(new Map([[url, { status: 404, body: "" }]]));

  await assert.rejects(
    () => verifyDomainBindingViaHttp(store, "acme.com", { fetch }),
    /returned 404/,
  );
});

test("verifyDomainBindingViaHttp throws when the body doesn't match", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const url = `http://acme.com/.well-known/zelavis-challenge/${binding.verificationToken}`;
  const fetch = createMockFetch(
    new Map([[url, { status: 200, body: "wrong-token" }]]),
  );

  await assert.rejects(
    () => verifyDomainBindingViaHttp(store, "acme.com", { fetch }),
    /did not match the expected token/,
  );
});

test("verifyDomainBindingViaHttp surfaces fetch failures with the URL in the message", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });

  const failingFetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    () =>
      verifyDomainBindingViaHttp(store, "acme.com", { fetch: failingFetch }),
    /HTTP-01 fetch of "http:\/\/acme\.com.*" failed: ECONNREFUSED/,
  );
});

test("verifyDomainBindingViaHttp honors scheme and challengePath overrides", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const url = `https://acme.com/custom/${binding.verificationToken}`;
  const fetch = createMockFetch(
    new Map([[url, { status: 200, body: binding.verificationToken }]]),
  );

  const verified = await verifyDomainBindingViaHttp(store, "acme.com", {
    fetch,
    scheme: "https",
    challengePath: "/custom",
  });
  assert.ok(verified.verifiedAt);
});

// ---------- createDomainChallengeService ----------

test("createDomainChallengeService serves the binding token to host-matched challenge requests", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const service = createDomainChallengeService(store);
  const runtime = await createServiceRuntime({ services: [service] });

  const response = await runtime.fetch(
    new Request(
      `http://acme.com/.well-known/zelavis-challenge/${binding.verificationToken}`,
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), binding.verificationToken);
});

test("createDomainChallengeService returns 404 for unknown hosts", async () => {
  const store = createInMemoryDomainBindingStore();
  const service = createDomainChallengeService(store);
  const runtime = await createServiceRuntime({ services: [service] });

  const response = await runtime.fetch(
    new Request(
      "http://unknown.example.com/.well-known/zelavis-challenge/anytoken",
    ),
  );
  assert.equal(response.status, 404);
});

test("createDomainChallengeService returns 404 when the token doesn't match the binding", async () => {
  const store = createInMemoryDomainBindingStore();
  await addDomainBinding(store, { host: "acme.com" });
  const service = createDomainChallengeService(store);
  const runtime = await createServiceRuntime({ services: [service] });

  const response = await runtime.fetch(
    new Request(
      "http://acme.com/.well-known/zelavis-challenge/wrong-token-value",
    ),
  );
  assert.equal(response.status, 404);
});

test("createDomainChallengeService serves unverified bindings (verification happens AFTER endpoint responds)", async () => {
  // The whole point of HTTP-01 is that the operator sees the endpoint
  // respond correctly first, then runs the verifier. If we required
  // verification before serving, the chicken-and-egg breaks.
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "pending.com" });
  // Note: NOT verified

  const service = createDomainChallengeService(store);
  const runtime = await createServiceRuntime({ services: [service] });

  const response = await runtime.fetch(
    new Request(
      `http://pending.com/.well-known/zelavis-challenge/${binding.verificationToken}`,
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), binding.verificationToken);
});

test("createDomainChallengeService honors a custom challengePath", async () => {
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const service = createDomainChallengeService(store, {
    challengePath: "/custom/challenge",
  });
  const runtime = await createServiceRuntime({ services: [service] });

  const response = await runtime.fetch(
    new Request(`http://acme.com/custom/challenge/${binding.verificationToken}`),
  );
  assert.equal(response.status, 200);
});

// ---------- End-to-end: HTTP-01 verifier hits the built-in responder ----------

test("HTTP-01 verifier successfully verifies through the built-in challenge service", async () => {
  // The full loop without any mocks beyond the fetch transport: the
  // verifier hits the in-process zelavis runtime which serves the
  // challenge response from the same binding store.
  const store = createInMemoryDomainBindingStore();
  const binding = await addDomainBinding(store, { host: "acme.com" });

  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    coreServices: { dashboard: false, auth: false, database: false },
    domainBindings: store,
  });

  // Fetch implementation that routes through the in-process runtime
  // instead of the network — this is what an integration test for
  // "the verifier finds the right server" looks like without an
  // actual HTTP server bound to a port.
  const fetch = async (url) => {
    return runtime.fetch(new Request(url));
  };

  const verified = await verifyDomainBindingViaHttp(store, "acme.com", {
    fetch,
  });
  assert.ok(verified.verifiedAt);
  assert.equal(verified.verificationMethod, "http-01");
});
