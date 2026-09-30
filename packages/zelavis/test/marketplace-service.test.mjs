import assert from "node:assert/strict";
import test from "node:test";

import { zelavis } from "../dist/index.js";
import { bundledServiceRegistry } from "./_bundled-services.mjs";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

const MARKETPLACE = "@zelavis/marketplace";

async function bootWithMarketplace() {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    serviceRegistry: await bundledServiceRegistry(),
  });
  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await response.json();
  const service = config.services.find((entry) => entry.name === MARKETPLACE);

  assert.ok(service, "the marketplace is not composed into the runtime");
  const auth = config.services.find((entry) => entry.name === "@zelavis/auth");
  assert.ok(auth, "Auth is not composed into the runtime");
  return { runtime, service, auth };
}

test("the marketplace reaches the dashboard as an ordinary service", async () => {
  const { service } = await bootWithMarketplace();

  // Its kind comes from its own manifest, read by the plugin loader. A
  // marketplace extends the Platform, which is what `plugin` means. That it
  // ships with the Platform is carried by `scope`, not by the kind.
  assert.equal(service.kind, "plugin");

  // Two menus, both contributed by `zelavis.plugins.ui.menus.create` in the package.
  // Nothing in the dashboard names the marketplace, so if these are missing
  // the button is simply gone.
  assert.equal(service.menus.length, 2);
  const [platform, project] = service.menus;
  assert.equal(platform.surface, "platform");
  assert.equal(platform.sectionLabel, "Explore");
  assert.equal(project.surface, "root");
  assert.equal(project.sectionLabel, "Extend");

  // Its pages ship in the dashboard, one workspace for both, so neither menu
  // points at a framed page of its own.
  assert.equal(platform.path, "/marketplace");
  assert.equal(project.path, "/marketplace");
  assert.equal(platform.page, undefined);
  assert.equal(project.page, undefined);
});

test("a bundled package's page resolves to a fetchable src", async () => {
  const { runtime, auth } = await bootWithMarketplace();

  // Each menu page has to be serialized with a src, or the dashboard mounts a
  // frame pointed at nothing. Auth is the bundled service that ships one.
  for (const menu of auth.menus) {
    assert.ok(menu.page.src, `${menu.page.id} has no src`);

    const response = await runtime.fetch(
      new Request(`http://localhost${menu.page.src}`),
      PLATFORM_OWNER_CONTEXT,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
  }
});

test("service page assets are unauthenticated to nobody", async () => {
  const { runtime, auth } = await bootWithMarketplace();

  const response = await runtime.fetch(
    new Request(`http://localhost${auth.menu.page.src}`),
  );

  assert.equal(response.status, 401);
});

test("one service's page assets cannot be read under another's name", async () => {
  const { runtime, auth } = await bootWithMarketplace();

  const response = await runtime.fetch(
    new Request(
      `http://localhost${auth.menu.page.src.replace(
        encodeURIComponent("@zelavis/auth"),
        encodeURIComponent("@zelavis/ui"),
      )}`,
    ),
    PLATFORM_OWNER_CONTEXT,
  );

  assert.equal(response.status, 404);
});
