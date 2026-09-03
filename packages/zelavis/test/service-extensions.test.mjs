import assert from "node:assert/strict";
import test from "node:test";
import {
  isServiceExtension,
  serviceExtensionOwners,
  serviceExtensionPoints,
} from "../dist/core/index.js";
import { defineOAuthProviders } from "../dist/app/auth/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const EXTENSIONS = "/zelavis/api/v1/runtime/extensions";

const gitlab = defineOAuthProviders("@acme/auth-gitlab", [
  {
    name: "gitlab",
    title: "GitLab",
    authorizationEndpoint: "https://gitlab.com/oauth/authorize",
    tokenEndpoint: "https://gitlab.com/oauth/token",
    issuer: "https://gitlab.com",
    jwksUrl: "https://gitlab.com/oauth/discovery/keys",
  },
]);

test("a service-owned capability is what makes a plugin an extension", () => {
  assert.equal(isServiceExtension(gitlab), true);
  assert.deepEqual(serviceExtensionOwners(gitlab), ["zelavis/auth"]);
  assert.deepEqual(serviceExtensionPoints(gitlab), [
    { owner: "zelavis/auth", capabilities: ["oauth"] },
  ]);
});

test("a domain namespace names no owner, so it extends nothing", () => {
  // `api:routes` and `provider:auth` say what a plugin implements, never whose
  // contract it is — which is why they cannot place it in someone's catalogue.
  for (const capabilities of [["api:routes"], ["provider:auth"], [], undefined]) {
    assert.equal(isServiceExtension({ capabilities }), false);
  }
});

test("one plugin can extend more than one service", () => {
  const both = {
    capabilities: ["zelavis/auth:oauth", "@acme/shop:payments", "api:routes"],
  };
  assert.deepEqual(serviceExtensionOwners(both).sort(), [
    "@acme/shop",
    "zelavis/auth",
  ]);
});

async function platform(catalog = []) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    ...(catalog.length ? { serviceRegistry: { catalog } } : {}),
  });
}

test("extensions are listed by what they extend", async () => {
  const runtime = await platform([
    { service: gitlab, status: "installed", source: "community" },
  ]);
  const response = await runtime.plain({ url: EXTENSIONS });

  assert.equal(response.status, 200);
  const point = response.body.extensionPoints.find(
    (entry) => entry.owner === "zelavis/auth",
  );
  assert.ok(point, "zelavis/auth should have an extension point");
  assert.deepEqual(point.capabilities, ["oauth"]);
  assert.equal(point.extensions[0].name, "@acme/auth-gitlab");
  assert.equal(point.extensions[0].status, "installed");
});

test("the listing can be narrowed to one service", async () => {
  const runtime = await platform([
    { service: gitlab, status: "available", source: "community" },
  ]);

  const matched = await runtime.plain({ url: `${EXTENSIONS}?owner=zelavis/auth` });
  assert.equal(matched.body.extensionPoints.length, 1);

  // This is what a plugin's own settings page asks for: everything installable
  // for it, and nothing else.
  const other = await runtime.plain({ url: `${EXTENSIONS}?owner=@acme/shop` });
  assert.deepEqual(other.body.extensionPoints, []);
});

test("an extension says whether the service it extends is installed", async () => {
  const orphan = defineOAuthProviders("@acme/orphan", [
    {
      name: "orphan",
      authorizationEndpoint: "https://example.com/a",
      tokenEndpoint: "https://example.com/t",
      userInfoEndpoint: "https://example.com/me",
    },
  ]);
  const runtime = await platform([
    {
      service: { ...orphan, capabilities: ["@acme/nothing:payments"] },
      status: "available",
      source: "community",
    },
  ]);

  const response = await runtime.plain({ url: `${EXTENSIONS}?owner=@acme/nothing` });
  const point = response.body.extensionPoints[0];
  // An extension does nothing until what it extends is running, so a client
  // can say so rather than offering an install that would achieve nothing.
  assert.equal(point.ownerInstalled, false);
});

test("an extension cannot be installed without what it extends", async () => {
  const runtime = await platform([
    {
      service: { ...gitlab, capabilities: ["@acme/nothing:payments"] },
      status: "available",
      source: "community",
    },
  ]);

  const refused = await runtime.plain({
    url: "/zelavis/api/v1/runtime/services/%40acme%2Fauth-gitlab",
    method: "PATCH",
    body: { status: "installed" },
  });

  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not installed/u);
});

test("an extension of an installed service can be installed", async () => {
  const runtime = await platform([
    { service: gitlab, status: "available", source: "community" },
  ]);

  // `zelavis/auth` is part of Zelavis, so anything extending it is always
  // installable — the check only bites for a service that can be absent.
  const installed = await runtime.plain({
    url: "/zelavis/api/v1/runtime/services/%40acme%2Fauth-gitlab",
    method: "PATCH",
    body: { status: "installed" },
  });
  assert.equal(installed.status, 200);
});

test("a core service counts as installed for the things extending it", async () => {
  const runtime = await platform([
    { service: gitlab, status: "available", source: "community" },
  ]);
  const response = await runtime.plain({ url: `${EXTENSIONS}?owner=zelavis/auth` });

  // `zelavis/auth` is composed rather than installed, so it never appears in
  // the service registry. A listing built from the registry alone would report
  // the one thing every auth extension points at as missing.
  assert.equal(response.body.extensionPoints[0].ownerInstalled, true);
});

test("a bare domain namespace is not read as a service to extend", async () => {
  // `app:project` says what a recipe implements. Reading the prefix as a
  // service owner invented an extension point called "app" and listed the
  // shipped recipes under it as though they extended something.
  assert.equal(isServiceExtension({ capabilities: ["app:project"] }), false);

  const runtime = await platform();
  const response = await runtime.plain({ url: EXTENSIONS });
  assert.ok(
    response.body.extensionPoints.every((point) => point.owner.includes("/")),
    "every extension point must name a real service",
  );
});
