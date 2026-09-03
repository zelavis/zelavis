import assert from "node:assert/strict";
import test from "node:test";
import { defineOAuthProviders } from "../dist/app/auth/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };

/** A provider someone else ships, declaring the capability core owns. */
const thirdPartyProviders = defineOAuthProviders("@acme/auth-gitlab", [
  {
    name: "gitlab",
    title: "GitLab",
    authorizationEndpoint: "https://gitlab.com/oauth/authorize",
    tokenEndpoint: "https://gitlab.com/oauth/token",
    issuer: "https://gitlab.com",
    jwksUrl: "https://gitlab.com/oauth/discovery/keys",
  },
]);

async function platform({ withThirdParty = false } = {}) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    // Omitted rather than set to an empty catalog: an explicit `[]` means
    // this runtime composes no services at all, core auth included.
    ...(withThirdParty
      ? {
          serviceRegistry: {
            catalog: [
              { service: thirdPartyProviders, status: "installed", source: "community" },
            ],
          },
        }
      : {}),
  });
}

const BASE = "/zelavis/api/v1/auth/oauth/connections";

test("a provider plugin declares the capability core owns", () => {
  assert.deepEqual(thirdPartyProviders.capabilities, ["zelavis/auth:oauth"]);
  assert.equal(thirdPartyProviders.service.oauthProviders.length, 1);
});

test("OAuth providers work with nothing installed", async () => {
  const runtime = await platform();
  const response = await runtime.plain({ url: `${BASE}` });

  assert.equal(response.status, 200);
  const names = response.body.providers.map((provider) => provider.provider);
  // No plugin required: the definitions core ships are usable on their own.
  // Only GitHub ships as a definition: it is not OIDC, so its profile
  // endpoint and claim mapping are real code. Every OIDC issuer is added by
  // pasting its issuer URL instead.
  assert.deepEqual(names.sort(), ["github"]);
  // Discovered but unconfigured: an operator still has to supply the client
  // credentials their installation was issued.
  assert.ok(response.body.providers.every((provider) => !provider.configured));
});

test("a provider someone else ships is discovered by capability", async () => {
  const runtime = await platform({ withThirdParty: true });
  const response = await runtime.plain({ url: `${BASE}` });

  // The extension point is the capability, not this package's own list: a
  // third-party plugin appears beside the built-in providers.
  const names = response.body.providers.map((provider) => provider.provider);
  assert.deepEqual(names.sort(), ["github", "gitlab"]);
});

test("an operator configures a provider and the secret never comes back", async () => {
  const runtime = await platform();
  const saved = await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: {
      clientId: "client-id-123",
      clientSecret: "super-secret-value",
      redirectUri: "https://example.com/zelavis/auth/callback",
    },
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.connection.clientId, "client-id-123");
  // The secret is write-only over the API. `hasClientSecret` is all a caller
  // needs, and returning the value would put it in every log that records a
  // response body.
  assert.equal(saved.body.connection.clientSecret, undefined);
  assert.equal(saved.body.connection.hasClientSecret, true);
  assert.ok(!JSON.stringify(saved.body).includes("super-secret-value"));

  const listed = await runtime.plain({ url: `${BASE}` });
  assert.ok(!JSON.stringify(listed.body).includes("super-secret-value"));
  assert.equal(
    listed.body.providers.find((provider) => provider.provider === "github").configured,
    true,
  );
});

test("editing a connection keeps a secret the caller was never shown", async () => {
  const runtime = await platform();
  await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: {
      clientId: "client-id-123",
      clientSecret: "super-secret-value",
      redirectUri: "https://example.com/callback",
    },
  });

  // The API never returns the secret, so a caller editing the redirect URI
  // cannot send it back. Dropping it would silently break sign-in.
  const edited = await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: { clientId: "client-id-123", redirectUri: "https://example.com/other" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.connection.hasClientSecret, true);
});

test("a redirect URI that is not https is refused", async () => {
  const runtime = await platform();
  const refused = await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: { clientId: "id", redirectUri: "http://example.com/callback" },
  });

  // The authorization code arrives on this URL, and a code is enough to
  // complete a sign-in.
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /https/u);

  const localhost = await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: { clientId: "id", redirectUri: "http://localhost:3000/callback" },
  });
  assert.equal(localhost.status, 200);
});

test("configuring a provider nobody defines is refused", async () => {
  const runtime = await platform();
  const response = await runtime.plain({
    url: `${BASE}/nope`,
    method: "PUT",
    body: { clientId: "id", redirectUri: "https://example.com/callback" },
  });
  assert.equal(response.status, 404);
});

test("the OAuth endpoints require permission to manage the installation", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => ({ id: "visitor", type: "user", roles: [], permissions: [] }),
  });

  // Client secrets and redirect URIs are here; anyone who can write them can
  // redirect an installation's sign-in.
  for (const [method, url] of [
    ["GET", BASE],
    ["PUT", `${BASE}/github`],
    ["DELETE", `${BASE}/github`],
  ]) {
    const response = await runtime.plain({ url, method, body: {} });
    assert.ok(
      response.status === 401 || response.status === 403,
      `${method} ${url} returned ${response.status}`,
    );
  }
});

test("core drives the flow and a definition supplies the provider", async () => {
  const runtime = await platform();
  await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: {
      clientId: "gh-client",
      clientSecret: "gh-secret",
      redirectUri: "https://example.com/zelavis/api/v1/auth/oauth/github/callback",
    },
  });

  // Core holds the state and PKCE verifier. A provider definition only says
  // where to send the browser and how to read what comes back.
  const started = await runtime.plain({
    url: "/zelavis/api/v1/auth/oauth/github/start",
    method: "POST",
    body: {},
  });

  assert.equal(started.status, 200);
  const url = new URL(started.body.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "gh-client");
  assert.equal(url.searchParams.get("response_type"), "code");
  // PKCE on every flow, not only public clients: it binds the code to the
  // browser that started it, so a stolen code cannot be redeemed elsewhere.
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(url.searchParams.get("state"));
  assert.ok(!started.body.authorizationUrl.includes("gh-secret"));
});

test("an unconfigured provider cannot start a sign-in", async () => {
  const runtime = await platform();
  const started = await runtime.plain({
    url: "/zelavis/api/v1/auth/oauth/google/start",
    method: "POST",
    body: {},
  });

  assert.notEqual(started.status, 200);
  // Whether it is unconfigured or switched off is not something an anonymous
  // caller learns.
  assert.ok(!JSON.stringify(started.body).includes("disabled"));
});

test("disabling a provider stops sign-in without deleting its credentials", async () => {
  const runtime = await platform();
  const body = {
    clientId: "gh-client",
    clientSecret: "gh-secret",
    redirectUri: "https://example.com/callback",
  };
  await runtime.plain({ url: `${BASE}/github`, method: "PUT", body });

  const disabled = await runtime.plain({
    url: `${BASE}/github`,
    method: "PUT",
    body: { ...body, clientSecret: undefined, enabled: false },
  });
  assert.equal(disabled.body.connection.enabled, false);
  assert.equal(disabled.body.connection.hasClientSecret, true);

  const started = await runtime.plain({
    url: "/zelavis/api/v1/auth/oauth/github/start",
    method: "POST",
    body: {},
  });
  assert.notEqual(started.status, 200);
});
