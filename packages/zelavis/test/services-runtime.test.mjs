import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";

async function dataDirectory() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-folder-runtime-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function dropPackage(root, directoryName, manifest, entry) {
  const packageDirectory = join(root, "services", directoryName);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageDirectory, "index.js"), entry);
}

function servicePackage(body) {
  return `import { zelavis } from ${JSON.stringify(new URL("../dist/sdk/fetch.js", import.meta.url).href)};
    export function register() {
      zelavis.createAPI({ hello: { list() { return ${JSON.stringify(body)}; } } });
    }`;
}

async function runtime(root) {
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: root }) });
  test.after(() => zv.close());
  return zv;
}

async function get(zv, path) {
  const response = await zv.fetch(new Request(`http://localhost${path}`));
  return { status: response.status, body: await response.json() };
}

test("a service dropped into the folder serves its own endpoint", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "hello",
    {
      name: "@acme/hello",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", namespace: "example", capabilities: ["api:routes"] },
    },
    servicePackage({ hello: "from the folder" }),
  );

  const zv = await runtime(root);
  assert.deepEqual(await get(zv, "/zelavis/api/v1/plugins/example/hello"), {
    status: 200,
    body: { hello: "from the folder" },
  });
});

test("a folder package cannot take over a core service name", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "shadow",
    {
      name: "zelavis/identity",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", namespace: "example" },
    },
    servicePackage({ pwned: true }),
  );

  // Refused before loading. Reaching the activation guard instead throws, so
  // one dropped-in package would stop the Platform from booting at all.
  const zv = await runtime(root);
  const config = await get(zv, "/zelavis/api/v1/runtime/config");
  assert.equal(config.status, 200);
  assert.equal((await get(zv, "/zelavis/api/v1/pwned/")).status, 404);
});

test("a Project runtime serves the packages in its own services folder", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "hello",
    {
      name: "@acme/hello",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", namespace: "example", capabilities: ["api:routes"] },
    },
    servicePackage({ hello: "from the project" }),
  );

  const zv = new Zelavis({
    adapter: nodeAdapter({ role: "project", dataDirectory: root, projects: false }),
  });
  test.after(() => zv.close());
  assert.deepEqual(await get(zv, "/zelavis/api/v1/plugins/example/hello"), {
    status: 200,
    body: { hello: "from the project" },
  });
});

async function dropFrontend(root, html, directory = "blog", name = "@acme/blog-frontend") {
  const packageDirectory = join(root, "services", directory);
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist", mode: "spa" } },
    }),
  );
  await writeFile(join(packageDirectory, "dist", "index.html"), html);
}

async function text(zv, path) {
  const response = await zv.fetch(new Request(`http://localhost${path}`));
  return { status: response.status, body: await response.text() };
}

test("a Project serves the static frontend in its own services folder at its root", async () => {
  const root = await dataDirectory();
  await dropFrontend(root, "<h1>the project's site</h1>");

  const zv = new Zelavis({
    adapter: nodeAdapter({ role: "project", dataDirectory: root, projects: false }),
  });
  test.after(() => zv.close());

  const home = await text(zv, "/");
  assert.equal(home.status, 200);
  assert.match(home.body, /the project's site/);
  // Taking the root does not shadow the runtime's own API.
  assert.equal((await get(zv, "/zelavis/api/v1/runtime/config")).status, 200);
});

test("selecting a frontend installs it and sets the previous one aside", async () => {
  const root = await dataDirectory();
  await dropFrontend(root, "<h1>first site</h1>", "blog", "@acme/blog-frontend");
  await dropFrontend(root, "<h1>second site</h1>", "shop", "@acme/shop-frontend");

  const zv = new Zelavis({
    adapter: nodeAdapter({ role: "project", dataDirectory: root, projects: false }),
  });
  test.after(() => zv.close());
  const owner = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

  // Two are installed by discovery; the choice is deterministic (name order).
  assert.match((await text(zv, "/")).body, /first site/);

  const selected = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services/%40acme%2Fshop-frontend", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "installed" }),
    }),
    owner,
  );
  assert.equal(selected.status, 200);

  assert.match((await text(zv, "/")).body, /second site/);
  const config = await get(zv, "/zelavis/api/v1/runtime/config");
  const status = Object.fromEntries(
    config.body.serviceRegistry.map((entry) => [entry.name, entry.status]),
  );
  assert.equal(status["@acme/shop-frontend"], "installed");
  assert.equal(status["@acme/blog-frontend"], "available");

  // And back again.
  await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services/%40acme%2Fblog-frontend", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "installed" }),
    }),
    owner,
  );
  assert.match((await text(zv, "/")).body, /first site/);
});

test("the selected frontend survives a restart", async () => {
  const root = await dataDirectory();
  await dropFrontend(root, "<h1>first site</h1>", "blog", "@acme/blog-frontend");
  await dropFrontend(root, "<h1>second site</h1>", "shop", "@acme/shop-frontend");
  const open = () =>
    new Zelavis({ adapter: nodeAdapter({ role: "project", dataDirectory: root, projects: false }) });
  const owner = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

  const first = open();
  await first.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services/%40acme%2Fshop-frontend", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "installed" }),
    }),
    owner,
  );
  await first.close();

  const second = open();
  test.after(() => second.close());
  assert.match((await text(second, "/")).body, /second site/);
});

test("the Platform has no frontend selection: folder frontends coexist under their own prefixes", async () => {
  const root = await dataDirectory();
  await dropFrontend(root, "<h1>first site</h1>", "blog", "@acme/blog-frontend");
  await dropFrontend(root, "<h1>second site</h1>", "shop", "@acme/shop-frontend");
  const zv = await runtime(root);
  const owner = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

  const installed = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services/%40acme%2Fshop-frontend", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "installed" }),
    }),
    owner,
  );
  assert.equal(installed.status, 200);

  // Installing one does not set the other aside: the Platform's own face is
  // fixed by its `frontend` option, and these are ordinary extension apps.
  const config = await get(zv, "/zelavis/api/v1/runtime/config");
  const status = Object.fromEntries(
    config.body.serviceRegistry.map((entry) => [entry.name, entry.status]),
  );
  assert.equal(status["@acme/shop-frontend"], "installed");
  assert.equal(status["@acme/blog-frontend"], "installed");
  assert.match((await text(zv, "/apps/%40acme%2Fblog-frontend/")).body, /first site/);
  assert.match((await text(zv, "/apps/%40acme%2Fshop-frontend/")).body, /second site/);
});

test("a Project without a frontend keeps its placeholder", async () => {
  const root = await dataDirectory();
  const zv = new Zelavis({
    adapter: nodeAdapter({ role: "project", dataDirectory: root, projects: false }),
  });
  test.after(() => zv.close());

  assert.equal((await text(zv, "/")).status, 503);
});

test("a frontend dropped into the Platform's folder cannot take over its root", async () => {
  const root = await dataDirectory();
  await dropFrontend(root, "<h1>squatter</h1>");
  const zv = await runtime(root);

  const home = await zv.fetch(new Request("http://localhost/"));
  assert.notEqual(await home.text().then((body) => body.includes("squatter")), true);
  // It is corralled under its own prefix, like any extension's app.
  const namespaced = await text(zv, "/apps/%40acme%2Fblog-frontend/");
  assert.equal(namespaced.status, 200);
  assert.match(namespaced.body, /squatter/);
});

test("a folder package cannot shadow an official bundled package", async () => {
  for (const name of ["@zelavis/marketplace", "@zelavis/auth", "@zelavis/app"]) {
    const root = await dataDirectory();
    await dropPackage(
      root,
      "shadow",
      {
        name,
        type: "module",
        exports: "./index.js",
        zelavis: { kind: "plugin", namespace: "shadow" },
      },
      servicePackage({ pwned: true }),
    );

    const zv = await runtime(root);
    const config = await get(zv, "/zelavis/api/v1/runtime/config");
    const entries = config.body.serviceRegistry.filter((entry) => entry.name === name);

    // One identity, and it is the immutable distribution's, not the folder's.
    assert.equal(entries.length, 1, name);
    assert.equal(entries[0].source, "official", name);
    assert.equal((await get(zv, "/zelavis/api/v1/plugins/shadow/hello")).status, 404, name);
  }
});

test("the registry API cannot register a package under an official identity", async () => {
  const root = await dataDirectory();
  const zv = await runtime(root);
  const specifier = "data:text/javascript," + encodeURIComponent(
    'export default { name: "@zelavis/marketplace", version: "9.9.9", kind: "plugin", api: {}, service: {} };',
  );

  const response = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "@zelavis/marketplace", specifier, status: "installed" }),
    }),
    { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } },
  );
  assert.equal(response.status, 400);

  const config = await get(zv, "/zelavis/api/v1/runtime/config");
  const [entry] = config.body.serviceRegistry.filter((item) => item.name === "@zelavis/marketplace");
  assert.equal(entry.source, "official");
});

test("the managed artifact directory is not scanned as a package", async () => {
  const root = await dataDirectory();
  await mkdir(join(root, "services", "packages", "0123abcd"), { recursive: true });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const zv = await runtime(root);
    assert.equal((await get(zv, "/zelavis/api/v1/runtime/config")).status, 200);
  } finally {
    console.warn = original;
  }

  assert.deepEqual(
    warnings.filter((warning) => warning.includes("packages")),
    [],
  );
});

test("a broken package leaves the rest of the installation working", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "broken",
    { name: "@acme/broken", type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace: "example" } },
    "throw new Error('this package explodes on import');",
  );
  await dropPackage(
    root,
    "working",
    {
      name: "@acme/working",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", namespace: "example", capabilities: ["api:routes"] },
    },
    servicePackage({ ok: true }),
  );

  const zv = await runtime(root);
  assert.equal((await get(zv, "/zelavis/api/v1/runtime/config")).status, 200);
  assert.deepEqual(await get(zv, "/zelavis/api/v1/plugins/example/hello"), {
    status: 200,
    body: { ok: true },
  });
});

test("nothing is discovered when the folder scan is turned off", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "hello",
    {
      name: "@acme/hello",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", namespace: "example", capabilities: ["api:routes"] },
    },
    servicePackage({ hello: "from the folder" }),
  );

  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, services: false }),
  });
  test.after(() => zv.close());
  assert.equal((await get(zv, "/zelavis/api/v1/plugins/example/hello")).status, 404);
});
