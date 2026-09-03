import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationCodeFlow } from "../dist/app/auth/index.js";
import { githubProvider } from "../dist/app/auth/index.js";

const CONNECTION = {
  provider: "github",
  clientId: "gh-client",
  clientSecret: "gh-secret",
  redirectUri: "https://example.com/callback",
  enabled: true,
  updatedAt: new Date().toISOString(),
};

function stubFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const target = String(url);
      calls.push({ url: target, init });
      const handler = handlers[Object.keys(handlers).find((key) => target.startsWith(key))];
      if (!handler) return new Response("no", { status: 404 });
      return handler(init);
    },
  };
}

test("a provider with no ID token is read from its profile endpoint", async () => {
  const { calls, fetch } = stubFetch({
    "https://github.com/login/oauth/access_token": () =>
      Response.json({ access_token: "at-123" }),
    "https://api.github.com/user": () =>
      Response.json({ id: 4242, login: "octocat", name: "The Octocat", email: "OCTO@Example.com" }),
  });

  const identity = await createAuthorizationCodeFlow(githubProvider, CONNECTION, { fetch })
    .exchange({
      code: "code-1",
      codeVerifier: "verifier-1",
      nonce: "nonce-1",
      redirectUri: CONNECTION.redirectUri,
    });

  // The numeric id, not the login: a GitHub username can be released and taken
  // by someone else, who would then inherit the account.
  assert.equal(identity.identifier, "4242");
  assert.equal(identity.username, "octocat");
  assert.equal(identity.email, "octo@example.com");
  // GitHub's profile does not say whether the address is verified, so it is
  // not claimed to be.
  assert.equal(identity.verified, false);

  const exchange = calls[0].init.body;
  assert.equal(exchange.get("code_verifier"), "verifier-1");
  assert.equal(exchange.get("client_secret"), "gh-secret");
  assert.equal(exchange.get("grant_type"), "authorization_code");
});

test("a failed exchange does not repeat the provider's response body", async () => {
  const { fetch } = stubFetch({
    "https://github.com/login/oauth/access_token": () =>
      new Response("invalid_client: secret gh-secret is wrong", { status: 401 }),
  });

  await assert.rejects(
    createAuthorizationCodeFlow(githubProvider, CONNECTION, { fetch }).exchange({
      code: "code-1",
      codeVerifier: "verifier-1",
      nonce: "nonce-1",
      redirectUri: CONNECTION.redirectUri,
    }),
    (error) => {
      // A provider can quote the request it rejected, and the request carried
      // the client secret. Only the status is repeated.
      assert.match(error.message, /status 401/u);
      assert.ok(!error.message.includes("gh-secret"));
      return true;
    },
  );
});

test("an OIDC provider without an ID token is refused rather than trusted", async () => {
  const oidc = {
    name: "acme",
    authorizationEndpoint: "https://id.example.com/authorize",
    tokenEndpoint: "https://id.example.com/token",
    issuer: "https://id.example.com",
    jwksUrl: "https://id.example.com/jwks",
  };
  const { fetch } = stubFetch({
    "https://id.example.com/token": () => Response.json({ access_token: "at" }),
  });

  await assert.rejects(
    createAuthorizationCodeFlow(oidc, { ...CONNECTION, provider: "acme" }, { fetch })
      .exchange({
        code: "c",
        codeVerifier: "v",
        nonce: "n",
        redirectUri: CONNECTION.redirectUri,
      }),
    /did not return an ID token/u,
  );
});

test("a provider that can neither be verified nor profiled is refused", async () => {
  // No issuer and no userInfo endpoint means nothing to authenticate against,
  // so there is no identity to believe.
  const { fetch } = stubFetch({
    "https://example.com/token": () => Response.json({ access_token: "at" }),
  });

  await assert.rejects(
    createAuthorizationCodeFlow(
      {
        name: "hollow",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
      },
      CONNECTION,
      { fetch },
    ).exchange({ code: "c", codeVerifier: "v", nonce: "n", redirectUri: CONNECTION.redirectUri }),
    /neither an issuer nor a userInfo endpoint/u,
  );
});

test("a definition declaring an issuer with no key set is refused at definition time", async () => {
  const { defineOAuthProviders } = await import("../dist/app/auth/index.js");
  // An issuer with no JWKS means an ID token nobody can verify, and an
  // unverified ID token is attacker-supplied JSON.
  assert.throws(
    () =>
      defineOAuthProviders("@acme/bad", [
        {
          name: "bad",
          authorizationEndpoint: "https://example.com/a",
          tokenEndpoint: "https://example.com/t",
          issuer: "https://example.com",
        },
      ]),
    /could not be verified/u,
  );
});
