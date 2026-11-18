import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { defineOAuthProviders } from "../dist/auth/index.js";

const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const settingsPath = "/zelavis/api/v1/auth/oauth/connections";
const issuer = "https://accounts.example.test";
const discovery = {
  issuer,
  authorization_endpoint: issuer + "/authorize",
  token_endpoint: issuer + "/token",
  jwks_uri: issuer + "/keys",
  id_token_signing_alg_values_supported: ["RS256"],
};
const entry = (service, status = "installed") => ({ service, status, source: "community" });

async function platform(t, catalog = []) {
  const fetched = [];
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: ({ request }) => request.headers.has("x-test-owner") ? owner : undefined,
    serviceRegistry: { catalog },
    subsystems: { auth: { oauth: { fetch: (url) => {
      fetched.push(String(url));
      return Promise.resolve(Response.json(discovery));
    } } } },
  });
  t.after(() => runtime.close());
  const request = (path, { method = "GET", body, admin = true } = {}) => runtime.fetch(new Request(new URL(path, "http://localhost"), {
    method,
    headers: {
      ...(admin ? { "x-test-owner": "1" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { request, fetched };
}

test("installed OAuth plugins are offered with their issuer; the operator supplies credentials", async (t) => {
  const service = defineOAuthProviders("@acme/auth-directory", [{ name: "directory", title: "Staff SSO", issuer, scopes: ["profile"] }]);
  assert.deepEqual(service.capabilities, ["zelavis/auth:oauth"]);
  const { request, fetched } = await platform(t, [
    entry(service),
    entry(defineOAuthProviders("@acme/auth-available", [{ name: "pending", issuer }]), "available"),
  ]);
  const listed = await request(settingsPath);
  assert.equal(listed.status, 200);
  const { providers } = await listed.json();
  assert.deepEqual(providers.map(({ provider }) => provider), ["apple", "directory", "github", "google"]);
  assert.equal(providers.find(({ provider }) => provider === "directory").configured, false);
  assert.deepEqual(await (await request("/zelavis/api/v1/auth/oauth/providers", { admin: false })).json(), { providers: [] });

  const body = { clientId: "client-id", clientSecret: "disposable-client-secret", redirectUri: "https://example.test/zelavis/api/v1/auth/oauth/directory/callback" };
  const denied = await request(settingsPath + "/directory", { method: "PUT", admin: false, body });
  assert.equal(denied.status, 401);
  assert.equal((await request(settingsPath + "/directory", { method: "PUT", body: { ...body, issuer: "https://other.example.test" } })).status, 400);
  assert.deepEqual(fetched, []);
  const saved = await request(settingsPath + "/directory", { method: "PUT", body });
  assert.equal(saved.status, 200, await saved.clone().text());
  const { connection } = await saved.json();
  assert.equal(connection.issuer, issuer);
  assert.equal(connection.hasClientSecret, true);
  assert.equal(connection.clientSecret, undefined);
  assert.deepEqual(fetched, [issuer + "/.well-known/openid-configuration"]);

  assert.deepEqual(await (await request("/zelavis/api/v1/auth/oauth/providers", { admin: false })).json(), { providers: [{ name: "directory", title: "Staff SSO" }] });
  const start = await request("/zelavis/api/v1/auth/oauth/directory/start", { method: "POST", admin: false, body: { redirectTo: "https://example.test/zelavis/oauth/callback" } });
  assert.equal(start.status, 200, await start.clone().text());
  const destination = new URL((await start.json()).url);
  assert.equal(destination.origin + destination.pathname, discovery.authorization_endpoint);
  assert.equal(destination.searchParams.get("scope"), "openid profile");
});

test("plugins cannot replace built-in or reserved provider names", () => {
  for (const name of ["github", "apple", "google", "providers", "connections"]) {
    assert.throws(() => defineOAuthProviders("@acme/auth-directory", [{ name, issuer }]), TypeError);
  }
  assert.throws(() => defineOAuthProviders("@acme/auth-directory", [{ name: "directory", issuer: "http://example.test" }]), TypeError);
});
