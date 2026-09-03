import assert from "node:assert/strict";
import test from "node:test";
import { discoverOidcProvider } from "../dist/app/auth/index.js";

const ISSUER = "https://id.example.com";

function configuration(overrides = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    id_token_signing_alg_values_supported: ["RS256", "ES256"],
    ...overrides,
  };
}

function stubFetch(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      return handler(String(url));
    },
  };
}

test("an issuer describes itself, so no constants are needed", async () => {
  const { calls, fetch } = stubFetch(() => Response.json(configuration()));
  const provider = await discoverOidcProvider(ISSUER, { fetch, name: "acme" });

  assert.equal(calls[0], `${ISSUER}/.well-known/openid-configuration`);
  assert.equal(provider.name, "acme");
  assert.equal(provider.authorizationEndpoint, `${ISSUER}/authorize`);
  assert.equal(provider.tokenEndpoint, `${ISSUER}/token`);
  assert.equal(provider.jwksUrl, `${ISSUER}/jwks`);
  assert.equal(provider.issuer, ISSUER);
  // Narrowed to what this issuer says it signs with, so a token signed with
  // anything else is refused rather than merely unexpected.
  assert.deepEqual(provider.algorithms, ["RS256", "ES256"]);
});

test("a document declaring a different issuer is refused", async () => {
  const { fetch } = stubFetch(() =>
    Response.json(configuration({ issuer: "https://attacker.example" })),
  );

  // Without this a redirect could hand back another provider's metadata, and
  // ID tokens would then be verified against the wrong keys.
  await assert.rejects(
    discoverOidcProvider(ISSUER, { fetch }),
    /declares a different issuer/u,
  );
});

test("plaintext is refused everywhere it would be trusted", async () => {
  const { fetch } = stubFetch(() =>
    Response.json(configuration({ jwks_uri: "http://id.example.com/jwks" })),
  );

  // The key set decides whether an ID token is genuine. Over plaintext anyone
  // on the path substitutes it.
  await assert.rejects(discoverOidcProvider(ISSUER, { fetch }), /must use https/u);
  await assert.rejects(
    discoverOidcProvider("http://id.example.com", { fetch }),
    /must use https/u,
  );
});

test("an incomplete document is refused rather than half-used", async () => {
  for (const missing of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const document = configuration();
    delete document[missing];
    const { fetch } = stubFetch(() => Response.json(document));
    await assert.rejects(
      discoverOidcProvider(ISSUER, { fetch }),
      new RegExp(`missing "${missing}"`, "u"),
    );
  }
});

test("an unreachable issuer reports the status, not a broken definition", async () => {
  const { fetch } = stubFetch(() => new Response("nope", { status: 503 }));
  await assert.rejects(discoverOidcProvider(ISSUER, { fetch }), /status 503/u);
});

test("a trailing slash on the issuer does not defeat the match", async () => {
  const { fetch } = stubFetch(() => Response.json(configuration()));
  const provider = await discoverOidcProvider(`${ISSUER}/`, { fetch });
  assert.equal(provider.issuer, ISSUER);
});
