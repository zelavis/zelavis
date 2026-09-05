import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const OWNER = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };

async function platform(options = {}) {
  return zelavis({
    systemStore: createMemorySystemStore(),
    resolvePrincipal: () => OWNER,
    ...options,
  });
}

async function authMenuEntries(runtime) {
  const config = await runtime.plain({ url: "/zelavis/api/v1/runtime/config" });
  return config.body.services.filter((service) => service.menu?.title === "Auth");
}

test("the settings page is a product service, not part of auth", async () => {
  const runtime = await platform();
  const names = Object.keys(runtime.services);

  // Two services, deliberately. `zelavis/auth` is the authority an
  // installation cannot run without; `@zelavis/auth` is a page that configures
  // it and can be removed without anyone losing the ability to sign in.
  assert.ok(names.includes("zelavis/auth"));
  assert.ok(names.includes("@zelavis/auth"));
});

test("exactly one Auth entry reaches the dashboard", async () => {
  const runtime = await platform();
  const entries = await authMenuEntries(runtime);

  // Core auth used to contribute its own menu. With both contributing one, the
  // sidebar carried two "Auth" items and the one without a page led nowhere.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "@zelavis/auth");
  assert.equal(entries[0].menu.page.id, "auth-settings");
});

test("the page is served through the ordinary service page route", async () => {
  const runtime = await platform();
  const [entry] = await authMenuEntries(runtime);
  const page = await runtime.plain({ url: entry.menu.page.src });

  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/u);
});

test("the page reads the endpoints anyone else could", async () => {
  const runtime = await platform();
  const [entry] = await authMenuEntries(runtime);
  const html = String((await runtime.plain({ url: entry.menu.page.src })).body);

  // Nothing privileged: the same versioned endpoints the CLI uses.
  assert.match(html, /\/auth\/bootstrap/u);
  assert.match(html, /\/auth\/oauth\/connections/u);
  assert.match(html, /runtime\/extensions\?owner=/u);
});

test("the catalogue points at the core service, not this package", async () => {
  const runtime = await platform();
  const [entry] = await authMenuEntries(runtime);
  const html = String((await runtime.plain({ url: entry.menu.page.src })).body);

  // Extensions declare `zelavis/auth:oauth`, so a catalogue asking for
  // `@zelavis/auth` would list nothing while looking like it worked. The two
  // names are close enough that this is worth pinning.
  assert.match(html, /const OWNER = "zelavis\/auth"/u);
});

test("removing the settings page leaves sign-in working", async () => {
  const runtime = await platform({ subsystems: { auth: false } });

  // With no auth service there is nothing to configure, so the page is not
  // composed either — and the Platform still serves its API.
  assert.equal(runtime.services["@zelavis/auth"], undefined);
  const config = await runtime.plain({ url: "/zelavis/api/v1/runtime/config" });
  assert.equal(config.status, 200);
});

test("an extension cannot claim the settings service name", async () => {
  const runtime = await platform();
  const status = await runtime.plain({ url: "/zelavis/api/v1/runtime/services" });
  const entry = status.body.services.find(
    (service) => service.name === "@zelavis/auth",
  );
  // Reserved like the other services the Platform composes, so an installed
  // package cannot replace the page that configures sign-in.
  assert.ok(entry === undefined || entry.scope !== "extension");
});
