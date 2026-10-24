import assert from "node:assert/strict";
import test from "node:test";

import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { bundledServiceRegistry } from "./_bundled-services.mjs";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

const OWNER = {
  principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

test("public service-page assets contain only build data across installations and viewers", async () => {
  const instances = [];
  for (const secret of ["private-installation-one", "private-installation-two"]) {
    const systemStore = createMemorySystemStore();
    await systemStore.set("platform", "master-secret", secret);
    instances.push(await zelavis({ systemStore, frontend: zelavisUiFrontend }));
  }
  for (const name of ["service-page.css", "service-elements.js", "service-ui.js", "service-ui.css"]) {
    const url = `http://localhost/zelavis/api/v1/runtime/${name}`;
    const responses = await Promise.all([
      instances[0].fetch(new Request(url)),
      instances[0].fetch(new Request(url), OWNER),
      instances[1].fetch(new Request(url)),
    ]);
    assert.ok(responses.every(response => response.status === 200), name);
    const bodies = await Promise.all(responses.map(response => response.text()));
    assert.equal(bodies[0], bodies[1], `${name}: viewer-independent`);
    assert.equal(bodies[0], bodies[2], `${name}: installation-independent`);
    assert.doesNotMatch(bodies[0], /private-installation-(one|two)/);
  }
});

async function boot() {
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    serviceRegistry: await bundledServiceRegistry(),
  });
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
  // Any bundled service that ships a page will do; Auth's is the one that
  // stays a framed page now that the marketplace lives in the dashboard.
  const auth = config.body.services.find(
    (service) => service.name === "@zelavis/auth",
  );

  return { get, pageSrc: auth.menu.page.src };
}

test("every URL a service page builds actually resolves", async () => {
  const { get, pageSrc } = await boot();
  const page = await get(pageSrc, OWNER);

  assert.equal(page.status, 200);

  // The page derives these from its own location. Relative-path arithmetic is
  // easy to get wrong and fails silently in a frame, so resolve them the way a
  // browser would and fetch each one.
  const base = new URL(pageSrc, "http://localhost");

  const stylesheetHref = page.body.match(
    /<link rel="stylesheet" href="([^"]*service-page\.css)"/,
  )?.[1];
  assert.ok(stylesheetHref, "the page links no stylesheet");

  const stylesheet = await get(new URL(stylesheetHref, base).pathname, OWNER);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.contentType, /text\/css/);
  assert.match(stylesheet.body, /--background:/);

  const apiRootExpr = page.body.match(/new URL\("((?:\.\.\/)+)", location\.href\)/)?.[1];
  assert.ok(apiRootExpr, "the page derives no API root");

  const apiRoot = new URL(apiRootExpr, base).pathname.replace(/\/$/, "");
  const bootstrap = await get(`${apiRoot}/auth/bootstrap`, OWNER);
  assert.equal(bootstrap.status, 200);

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
  // that styles a form as flex silently un-hides it. A form styled as
  // flex stayed visible on an installation that could not use it.
  assert.match(stylesheet.body, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("service page styles are public, so a sandboxed extension page can load them", async () => {
  const { get } = await boot();
  // A page an extension ships runs in a frame with an opaque origin, which sends no credentials.
  const stylesheet = await get("/zelavis/api/v1/runtime/service-page.css");

  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.body, /--background:/);
});

test("a service page drives the real API, not a mock", async () => {
  const { get, pageSrc } = await boot();
  const page = await get(pageSrc, OWNER);

  assert.match(page.body, /\/auth\/bootstrap/);
  assert.match(page.body, /\/runtime\/extensions/);
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

test("the element library is public, cross-origin readable and revalidates by ETag", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend, serviceRegistry: await bundledServiceRegistry() });
  for (const name of ["service-elements.js", "service-page.css"]) {
    const url = `http://localhost/zelavis/api/v1/runtime/${name}`;
    const response = await runtime.fetch(new Request(url));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", name);
    const etag = response.headers.get("etag");
    assert.ok(etag, `${name} has an ETag`);
    assert.equal((await runtime.fetch(new Request(url, { headers: { "if-none-match": etag } }))).status, 304, name);
  }
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

test("an HTML service page gets the frontend's components without asking", async () => {
  const { get, pageSrc } = await boot();
  const page = await get(pageSrc, OWNER);

  assert.match(page.body, /<link rel="stylesheet" href="\/zelavis\/api\/v1\/runtime\/service-ui\.css" data-zelavis-service-ui>/);
  assert.match(page.body, /<script type="module" src="\/zelavis\/api\/v1\/runtime\/service-ui\.js" data-zelavis-service-ui><\/script>/);
  // At the top of the head, so the elements are defined before the page's own module runs its first line.
  assert.ok(page.body.indexOf("service-ui.js") < page.body.indexOf("<body"));

  const script = await get("/zelavis/api/v1/runtime/service-ui.js", OWNER);
  assert.equal(script.status, 200);
  assert.match(script.contentType, /text\/javascript/);
  // The runtime is the zv brand of fuzor/ui: one module defining the tags a page writes.
  assert.match(script.body, /zv/);
  const stylesheet = await get("/zelavis/api/v1/runtime/service-ui.css", OWNER);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.contentType, /text\/css/);
  assert.match(stylesheet.body, /zv-select-trigger/);
  // It reads a service page's tokens as well as the dashboard's.
  assert.match(stylesheet.body, /--popover/);
});

test("the component runtime is public, cross-origin readable and revalidates by ETag", async () => {
  const runtime = await zelavis({ frontend: zelavisUiFrontend, serviceRegistry: await bundledServiceRegistry() });
  // A sandboxed extension page has an opaque origin and no credentials, so the runtime cannot require either.
  for (const kind of ["js", "css"]) {
    const url = `http://localhost/zelavis/api/v1/runtime/service-ui.${kind}`;
    const response = await runtime.fetch(new Request(url));
    assert.equal(response.status, 200, kind);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const etag = response.headers.get("etag");
    assert.ok(etag, "an ETag names the revision");
    const again = await runtime.fetch(new Request(url, { headers: { "if-none-match": etag } }));
    assert.equal(again.status, 304, "an unchanged asset is not sent again");
  }
});

test("injection puts the runtime at the top of the head, once, and respects an opt-out", async () => {
  const { injectServiceUi } = await import("../dist/platform/service-page-ui.js");
  const links = { stylesheet: "/ui.css", script: "/ui.js" };

  const page = injectServiceUi('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>', links);
  assert.match(page, /<head><link rel="stylesheet" href="\/ui\.css" data-zelavis-service-ui><script type="module" src="\/ui\.js" data-zelavis-service-ui><\/script><meta charset/);
  assert.equal(injectServiceUi(page, links), page, "a page that already has it is left alone");

  const bare = injectServiceUi("<p>hi</p>", links);
  assert.ok(bare.startsWith('<link rel="stylesheet"'), "a fragment with no head still gets it");
  assert.match(injectServiceUi("<html><body>x</body></html>", links), /^<html><head><link/);

  const optedOut = '<head><meta name="zelavis-service-ui" content="none"></head><body></body>';
  assert.equal(injectServiceUi(optedOut, links), optedOut);
  assert.equal(injectServiceUi("<head><META NAME='zelavis-service-ui' CONTENT='none'></head>", links), "<head><META NAME='zelavis-service-ui' CONTENT='none'></head>");
});

test("a frontend with no component runtime adds nothing and serves 404", async () => {
  const runtime = await zelavis({
    frontend: async (context) => {
      const { serviceUi: _omitted, ...rest } = await zelavisUiFrontend(context);
      return rest;
    },
    serviceRegistry: await bundledServiceRegistry(),
  });
  const response = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/service-ui.js"), OWNER);
  assert.equal(response.status, 404);
});

test("a page capability is authentic, scoped, expiring, and tamper-evident", async () => {
  const { mintPageCapability, verifyPageCapability } = await import("../dist/platform/page-capability.js");
  const secret = "installation-secret";
  const claims = { service: "@acme/shop", bundle: "dist", expiresAt: Date.now() + 60_000 };
  const token = await mintPageCapability(secret, claims);

  assert.deepEqual(await verifyPageCapability(secret, token), claims);
  assert.deepEqual(await verifyPageCapability(secret, await mintPageCapability(secret, { ...claims, projectId: "p1" })), { ...claims, projectId: "p1" });
  // Another installation's secret, a changed payload and a changed signature are all just "not authorized".
  assert.equal(await verifyPageCapability("another-secret", token), undefined);
  const [payload, signature] = token.split(".");
  const other = await mintPageCapability(secret, { ...claims, service: "@acme/other" });
  assert.equal(await verifyPageCapability(secret, `${other.split(".")[0]}.${signature}`), undefined);
  assert.equal(await verifyPageCapability(secret, `${payload}.${signature.slice(0, -2)}AA`), undefined);
  assert.equal(await verifyPageCapability(secret, `${payload}.`), undefined);
  assert.equal(await verifyPageCapability(secret, "not a token"), undefined);
  assert.equal(await verifyPageCapability(secret, `${payload}.a`), undefined);
  assert.equal(await verifyPageCapability(secret, "x".repeat(3000)), undefined);
  for (const invalid of [{ bundle: ".." }, { service: "@acme/../shop" }, { projectId: "p1/../p2" }, { expiresAt: claims.expiresAt + 0.5 }]) {
    assert.equal(await verifyPageCapability(secret, await mintPageCapability(secret, { ...claims, ...invalid })), undefined, JSON.stringify(invalid));
  }
  // Expiry is checked against the clock it is asked about.
  assert.equal(await verifyPageCapability(secret, token, claims.expiresAt + 1), undefined);
});
