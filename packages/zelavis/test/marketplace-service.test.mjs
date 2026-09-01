import assert from "node:assert/strict";
import test from "node:test";

import { zelavis } from "../dist/index.js";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

const MARKETPLACE = "@zelavis/marketplace";

async function bootWithMarketplace() {
  const runtime = await zelavis({});
  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  const config = await response.json();
  const service = config.services.find((entry) => entry.name === MARKETPLACE);

  assert.ok(service, "the marketplace is not composed into the runtime");
  return { runtime, service };
}

test("the marketplace reaches the dashboard as an ordinary service", async () => {
  const { service } = await bootWithMarketplace();

  // Its kind comes from its own manifest, read by the plugin loader. "core"
  // because that is what it is — a product service shipped with the Platform.
  // How it was loaded is not what `kind` describes.
  assert.equal(service.kind, "core");

  // Two menus, both contributed by `zelavis.menu.create` in the package.
  // Nothing in the dashboard names the marketplace, so if these are missing
  // the button is simply gone.
  assert.equal(service.menus.length, 2);
  const [platform, project] = service.menus;
  assert.equal(platform.surface, "platform");
  assert.equal(platform.sectionLabel, "Explore");
  assert.equal(project.surface, "root");
  assert.equal(project.sectionLabel, "Extend");
});

test("a core service's page resolves to a fetchable src", async () => {
  const { runtime, service } = await bootWithMarketplace();

  // A core service is not a registry entry. Its menu still has to be
  // serialized, or the dashboard mounts a frame pointed at nothing.
  for (const menu of service.menus) {
    assert.ok(menu.page.src, `${menu.page.id} has no src`);

    const response = await runtime.fetch(
      new Request(`http://localhost${menu.page.src}`),
      PLATFORM_OWNER_CONTEXT,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);

    // The page drives the real registry API from inside its frame rather than
    // rendering a fixed document.
    const html = await response.text();
    assert.match(html, /<h1>Services<\/h1>/);
    assert.match(html, /\/runtime\/services/);
  }
});

test("service page assets are unauthenticated to nobody", async () => {
  const { runtime, service } = await bootWithMarketplace();

  const response = await runtime.fetch(
    new Request(`http://localhost${service.menu.page.src}`),
  );

  assert.equal(response.status, 401);
});

test("one service's page assets cannot be read under another's name", async () => {
  const { runtime, service } = await bootWithMarketplace();

  const response = await runtime.fetch(
    new Request(
      `http://localhost${service.menu.page.src.replace(
        encodeURIComponent(MARKETPLACE),
        encodeURIComponent("@zelavis/ui"),
      )}`,
    ),
    PLATFORM_OWNER_CONTEXT,
  );

  assert.equal(response.status, 404);
});
