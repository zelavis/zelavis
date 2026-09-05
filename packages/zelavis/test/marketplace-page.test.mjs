import assert from "node:assert/strict";
import test from "node:test";

import { zelavis } from "../dist/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

const OWNER = {
  principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

async function boot() {
  const runtime = await zelavis({ frontend: zelavisUiFrontend });
  // Takes the context explicitly rather than defaulting it: a default would
  // turn "call this anonymously" into "call this as the owner", and the test
  // asserting anonymous access is refused would pass while proving nothing.
  const get = async (path, context) => {
    const response = await runtime.fetch(
      new Request(`http://localhost${path}`),
      context,
    );
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      contentType: type,
      body: type.includes("json")
        ? await response.json()
        : await response.text(),
    };
  };

  const config = await get("/zelavis/api/v1/runtime/config", OWNER);
  const marketplace = config.body.services.find(
    (service) => service.name === "@zelavis/marketplace",
  );

  return { get, pageSrc: marketplace.menu.page.src };
}

test("every URL the marketplace page builds actually resolves", async () => {
  const { get, pageSrc } = await boot();
  const page = await get(pageSrc, OWNER);

  assert.equal(page.status, 200);

  // The page derives these from its own location. Relative-path arithmetic is
  // easy to get wrong and fails silently in a frame, so resolve them the way a
  // browser would and fetch each one.
  const base = new URL(pageSrc, "http://localhost");

  const stylesheetHref = page.body.match(
    /<link rel="stylesheet" href="([^"]+)"/,
  )?.[1];
  assert.ok(stylesheetHref, "the page links no stylesheet");

  const stylesheet = await get(new URL(stylesheetHref, base).pathname, OWNER);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.contentType, /text\/css/);
  assert.match(stylesheet.body, /--background:/);

  // Same arithmetic, same failure mode: the element library is loaded by a
  // relative path from a page mounted several segments deep.
  const elementsSrc = page.body.match(
    /<script type="module" src="([^"]+)"><\/script>/,
  )?.[1];
  assert.ok(elementsSrc, "the page loads no element library");

  const elements = await get(new URL(elementsSrc, base).pathname, OWNER);
  assert.equal(elements.status, 200);
  assert.match(elements.contentType, /javascript/);
  assert.match(elements.body, /customElements\.define/);

  const apiRootExpr = page.body.match(/new URL\("((?:\.\.\/)+)", location\.href\)/)?.[1];
  assert.ok(apiRootExpr, "the page derives no API root");

  const apiRoot = new URL(apiRootExpr, base).pathname.replace(/\/$/, "");
  const services = await get(`${apiRoot}/runtime/services`, OWNER);
  assert.equal(services.status, 200);
  assert.ok(Array.isArray(services.body.services));

  const config = await get(`${apiRoot}/runtime/config`, OWNER);
  assert.equal(config.status, 200);
});

test("the stylesheet carries the dashboard's own tokens", async () => {
  const { get } = await boot();
  const stylesheet = await get("/zelavis/api/v1/runtime/service-page.css", OWNER);

  // Generated from app/styles.css, so a page inherits the installation's
  // palette rather than inventing one.
  assert.match(stylesheet.body, /--foreground:/);
  assert.match(stylesheet.body, /--primary:/);
  assert.match(stylesheet.body, /prefers-color-scheme: dark/);
  // Design tokens, not the dashboard's component classes.
  assert.doesNotMatch(stylesheet.body, /\.sidebar|tailwind/i);
});

test("the stylesheet keeps the hidden attribute working", async () => {
  const { get } = await boot();
  const stylesheet = await get("/zelavis/api/v1/runtime/service-page.css", OWNER);

  // Any explicit `display` beats the user-agent rule for `hidden`, so a page
  // that styles a form as flex silently un-hides it. The marketplace hit this
  // exactly: its install form stayed visible on an installation that cannot
  // install anything.
  assert.match(stylesheet.body, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("service page styles are not readable by an anonymous caller", async () => {
  const { get } = await boot();
  const stylesheet = await get("/zelavis/api/v1/runtime/service-page.css");

  assert.equal(stylesheet.status, 401);
});

test("the marketplace page drives the real registry API, not a mock", async () => {
  const { get, pageSrc } = await boot();
  const page = await get(pageSrc, OWNER);

  assert.match(page.body, /\/runtime\/services/);
  // Installing goes through the same endpoint and the same acquisition path
  // an operator would use directly.
  assert.match(page.body, /packageSource/);
  assert.match(page.body, /supportsPackageAcquisition/);
});

test("the element library defines the tags a service page composes", async () => {
  const { get } = await boot();
  const elements = await get(
    "/zelavis/api/v1/runtime/service-elements.js",
    OWNER,
  );

  assert.equal(elements.status, 200);

  // The library is the contract a service page writes against, so the tags it
  // defines are as much a public surface as the endpoints are.
  for (const tag of [
    "zv-page",
    "zv-section",
    "zv-card",
    "zv-stack",
    "zv-row",
    "zv-title",
    "zv-badge",
    "zv-button",
    "zv-field",
    "zv-empty",
    "zv-status",
  ]) {
    assert.match(elements.body, new RegExp(`define\\("${tag}"`), tag);
  }

  // Components style themselves in a shadow root, so a page's CSS cannot reach
  // in and a component's rules cannot leak out.
  assert.match(elements.body, /attachShadow\(\{ mode: "open" \}\)/);
  // Restyling happens through tokens rather than by overriding component CSS.
  assert.match(elements.body, /var\(--border\)/);
});

test("the element library is not readable by an anonymous caller", async () => {
  const { get } = await boot();
  const elements = await get("/zelavis/api/v1/runtime/service-elements.js");

  assert.equal(elements.status, 401);
});

test("a frontend can supply its own element library", async () => {
  // The Platform ships a baseline so a page is never left composing nothing;
  // the components themselves belong to whichever frontend is installed.
  const runtime = await zelavis({
    frontend: async (context) => ({
      ...(await zelavisUiFrontend(context)),
      serviceElementsScript: "/* the frontend's own components */",
    }),
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/service-elements.js"),
    OWNER,
  );

  assert.equal(await response.text(), "/* the frontend's own components */");
});
