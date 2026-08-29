import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createAuth, defineAuthService } from "../dist/app/auth/index.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { oidcService } from "../../../plugins/auth-oidc/dist/index.js";

test("OIDC plugin exchanges Authorization Code with PKCE and verifies ID-token nonce", async () => {
  const issuer = "https://identity.example";
  const clientId = "zelavis-test";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  let expectedNonce = "";
  let wrongNonce = false;
  let tokenRequestBody;

  const service = oidcService({
    issuer,
    audience: clientId,
    jwksUrl: `data:application/json,${encodeURIComponent(JSON.stringify({ keys: [publicJwk] }))}`,
    algorithms: ["RS256"],
    authorizationCode: {
      clientId,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      redirectUri: "http://localhost/auth/oauth/oidc/callback",
      fetch: async (_input, init) => {
        tokenRequestBody = new URLSearchParams(String(init.body));
        const idToken = await new SignJWT({
          nonce: wrongNonce ? "wrong-nonce" : expectedNonce,
          email: "oidc@example.com",
          email_verified: true,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject("subject-oidc")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const auth = await createAuth({ methods: [service.service] });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  const started = await runtime.plain({
    url: "/auth/oauth/oidc/start",
    method: "POST",
  });
  const authorizationUrl = new URL(started.body.authorizationUrl);
  expectedNonce = authorizationUrl.searchParams.get("nonce");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.equal(authorizationUrl.searchParams.has("code_verifier"), false);

  const completed = await runtime.plain({
    url: `/auth/oauth/oidc/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}&code=test-code`,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.account.email, "oidc@example.com");
  assert.equal(tokenRequestBody.get("code"), "test-code");
  assert.ok(tokenRequestBody.get("code_verifier"));

  wrongNonce = true;
  const secondStart = await runtime.plain({
    url: "/auth/oauth/oidc/start",
    method: "POST",
  });
  const secondUrl = new URL(secondStart.body.authorizationUrl);
  expectedNonce = secondUrl.searchParams.get("nonce");
  const rejected = await runtime.plain({
    url: `/auth/oauth/oidc/callback?state=${encodeURIComponent(secondUrl.searchParams.get("state"))}&code=test-code-2`,
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /nonce/);
});
