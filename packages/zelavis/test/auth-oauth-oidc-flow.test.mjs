import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineOAuthProviders, zelavisAuthService } from "@zelavis/auth";
import { oidcProvider } from "@zelavis/auth";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const ISSUER = "https://identity.example";
const CLIENT_ID = "zelavis-test";
const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };

/**
 * The full OIDC round trip through core auth's flow endpoints, with a real
 * signed ID token verified against a real key set. Ported from the OIDC
 * plugin, whose Authorization Code half `@zelavis/auth` replaced.
 */
async function platform() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";

  const state = { nonce: "", useWrongNonce: false, tokenRequest: undefined };

  const provider = oidcProvider({
    name: "oidc",
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUrl: `data:application/json,${encodeURIComponent(
      JSON.stringify({ keys: [publicJwk] }),
    )}`,
    algorithms: ["RS256"],
  });

  const fetchImpl = async (_input, init) => {
    state.tokenRequest = new URLSearchParams(String(init.body));
    const idToken = await new SignJWT({
      nonce: state.useWrongNonce ? "wrong-nonce" : state.nonce,
      email: "oidc@example.com",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("subject-oidc")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return Response.json({ id_token: idToken });
  };

  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    serviceRegistry: {
      catalog: [
        {
          // Constructed with the stub fetch so the token exchange is real
          // code against a real signed token, not a mock of the exchange.
          service: zelavisAuthService({ fetch: fetchImpl }),
          status: "installed",
          source: "official",
        },
        {
          service: defineOAuthProviders("@test/oidc", [provider]),
          status: "installed",
          source: "official",
        },
      ],
    },
    subsystems: { auth: { authOptions: {} } },
  });

  return { runtime, state };
}

test("an OIDC sign-in verifies the ID token against the issuer's keys", async () => {
  const { runtime, state } = await platform();

  await runtime.plain({
    url: "/zelavis/api/v1/auth/connections/providers/oidc",
    method: "PUT",
    body: {
      clientId: CLIENT_ID,
      clientSecret: "oidc-secret",
      redirectUri: "http://localhost/zelavis/api/v1/auth/oauth/oidc/callback",
    },
  });

  const started = await runtime.plain({
    url: "/zelavis/api/v1/auth/oauth/oidc/start",
    method: "POST",
  });
  assert.equal(started.status, 200);
  const authorizationUrl = new URL(started.body.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  // The verifier stays on the server; only its hash is sent to the provider.
  assert.equal(authorizationUrl.searchParams.has("code_verifier"), false);

  state.nonce = authorizationUrl.searchParams.get("nonce");
  const completed = await runtime.plain({
    url: `/zelavis/api/v1/auth/oauth/oidc/callback?state=${encodeURIComponent(
      authorizationUrl.searchParams.get("state"),
    )}&code=test-code`,
  });

  assert.equal(completed.status, 200);
  assert.equal(completed.body.account.email, "oidc@example.com");
  assert.equal(state.tokenRequest.get("code"), "test-code");
  assert.ok(state.tokenRequest.get("code_verifier"));
});

test("an ID token whose nonce does not match the flow is refused", async () => {
  const { runtime, state } = await platform();
  await runtime.plain({
    url: "/zelavis/api/v1/auth/connections/providers/oidc",
    method: "PUT",
    body: {
      clientId: CLIENT_ID,
      clientSecret: "oidc-secret",
      redirectUri: "http://localhost/zelavis/api/v1/auth/oauth/oidc/callback",
    },
  });

  const started = await runtime.plain({
    url: "/zelavis/api/v1/auth/oauth/oidc/start",
    method: "POST",
  });
  const url = new URL(started.body.authorizationUrl);
  state.nonce = url.searchParams.get("nonce");
  // A correctly signed token for the right issuer and audience, but from a
  // different sign-in attempt. Without the nonce check, a token replayed from
  // one flow would complete another.
  state.useWrongNonce = true;

  const rejected = await runtime.plain({
    url: `/zelavis/api/v1/auth/oauth/oidc/callback?state=${encodeURIComponent(
      url.searchParams.get("state"),
    )}&code=test-code-2`,
  });

  assert.notEqual(rejected.status, 200);
  assert.match(JSON.stringify(rejected.body), /sign-in attempt|nonce/u);
});
