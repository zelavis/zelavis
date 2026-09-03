import assert from "node:assert/strict";
import test from "node:test";

import { zelavis } from "../dist/index.js";

const OWNER = {
  principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

async function boot(options = {}) {
  const runtime = await zelavis(options);
  return async (path, context) => {
    const response = await runtime.fetch(
      new Request(`http://localhost${path}`),
      context,
    );
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      body: type.includes("json") ? await response.json() : await response.text(),
    };
  };
}

test("an installation with no frontend serves its whole API", async () => {
  const get = await boot();

  // The Platform names no frontend, so this is a supported state rather than a
  // broken one. Everything the dashboard does, it does through these.
  assert.equal((await get("/zelavis/api/v1/runtime/config")).status, 200);
  assert.equal((await get("/zelavis/api/v1/runtime/services", OWNER)).status, 200);
  assert.equal((await get("/zelavis/api/v1/runtime/settings", OWNER)).status, 200);
  assert.equal((await get("/zelavis/api/v1/runtime/access", OWNER)).status, 200);
});

test("the root path explains that no frontend is installed", async () => {
  const get = await boot();
  const root = await get("/zelavis/");

  // A 404 here reads as a broken deployment. This state is neither broken nor
  // permanent, so it says which it is and how to leave it.
  assert.equal(root.status, 200);
  assert.match(root.body, /No frontend installed/);
  assert.match(root.body, /marketplace/i);
  assert.match(root.body, /product-services/);
});

test("the missing-frontend page never answers for the API", async () => {
  const get = await boot();

  // It is mounted at the root path and matches everything under it, so a
  // mistyped API path has to keep its own 404 rather than render a page.
  for (const path of [
    "/zelavis/api/v1/runtime/nope",
    "/zelavis/api/v1/does-not-exist",
    "/zelavis/api",
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("service pages still get design tokens with no frontend", async () => {
  const get = await boot();
  const stylesheet = await get("/zelavis/api/v1/runtime/service-page.css", OWNER);

  // A design system belongs to a frontend, so with none installed the Platform
  // serves a neutral baseline in the browser's own colours — a service page
  // renders legibly rather than unstyled.
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.body, /--foreground/);
  assert.match(stylesheet.body, /no frontend supplied a design system/);
});

test("a service page still renders with no frontend installed", async () => {
  const get = await boot();
  const config = await get("/zelavis/api/v1/runtime/config");
  const marketplace = config.body.services.find(
    (service) => service.name === "@zelavis/marketplace",
  );

  // The marketplace is how a frontend gets installed, so it has to work in the
  // state where none is.
  const page = await get(marketplace.menu.page.src, OWNER);
  assert.equal(page.status, 200);
});

test("dashboard: false serves nothing at the root path", async () => {
  const get = await boot({ frontend: false });

  // Distinct from having no frontend installed: this is Zelavis embedded as an
  // API on purpose, and a friendly page would be an intrusion.
  assert.equal((await get("/zelavis/")).status, 404);
  assert.equal((await get("/zelavis/api/v1/runtime/config")).status, 200);
});
