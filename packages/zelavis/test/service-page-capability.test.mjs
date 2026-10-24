import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { zelavis, createMemorySystemStore } from "../dist/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";
import { projectPageRequest } from "../dist/platform/page-capability.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const VIEWER = { principal: { id: "viewer", type: "user", roles: [], permissions: [] } };

async function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "zelavis-page-capability-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dashboard"), { recursive: true });
  writeFileSync(join(directory, "dashboard", "index.html"), '<!doctype html><html><head><title>x</title></head><body><script type="module" src="./app.js"></script></body></html>');
  writeFileSync(join(directory, "dashboard", "app.js"), "console.log('own script');");
  writeFileSync(join(directory, "dashboard", "styles.css"), "body{color:red}");
  writeFileSync(join(directory, "secret.txt"), "outside the bundle");
  mkdirSync(join(directory, "other"));
  writeFileSync(join(directory, "other", "private.txt"), "another bundle");
  symlinkSync(join(directory, "secret.txt"), join(directory, "dashboard", "linked.txt"));
  symlinkSync(join(directory, "other"), join(directory, "dashboard", "linked-directory"));
  symlinkSync(directory, join(directory, "root-alias"));
  const page = { id: "main", title: "Main", bundle: "dashboard", file: "index.html" };
  const service = (name) => ({ name, kind: "plugin", packageDir: directory, menu: { title: name, path: `/${name.split("/")[1]}`, page } });
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    frontend: zelavisUiFrontend,
    serviceRegistry: { catalog: [{ service: service("@example/one"), status: "installed" }, { service: service("@example/two"), status: "installed" }] },
  });
  const call = (path, init, context) => runtime.fetch(new Request(`http://localhost${path}`, init), context);
  // The context is explicit, never defaulted: a default would turn "call this anonymously" into "call this as the owner".
  const mint = (query, context) => call(`/zelavis/api/v1/runtime/service-page-capability?${new URLSearchParams(query)}`, undefined, context);
  return { call, mint };
}

test("a minted capability reads a page and its sibling files with no credentials at all", async (t) => {
  const { call, mint } = await boot(t);
  const minted = await mint({ service: "@example/one", bundle: "dashboard", file: "index.html" }, OWNER);
  assert.equal(minted.status, 200);
  const { src } = await minted.json();
  assert.match(src, /^\/zelavis\/api\/v1\/runtime\/page-capabilities\/[^/]+\/dashboard\/index\.html$/);

  // No context: what a sandboxed frame's own requests look like.
  const page = await call(src);
  assert.equal(page.status, 200);
  // A module the sandboxed page imports is a CORS request from an opaque origin.
  assert.equal(page.headers.get("access-control-allow-origin"), "*");
  const html = await page.text();
  assert.match(html, /own script|src="\.\/app\.js"/);
  assert.match(html, /service-ui\.js/, "the component runtime is injected into the page");

  // The relative links in the page resolve under the capability, so they carry it.
  for (const [file, pattern] of [["app.js", /own script/], ["styles.css", /color:red/]]) {
    const sibling = await call(`${dirname(src)}/${file}`);
    assert.equal(sibling.status, 200, file);
    assert.match(await sibling.text(), pattern);
  }
});

test("a capability reads only the bundle it names", async (t) => {
  const { call, mint } = await boot(t);
  const { src } = await (await mint({ service: "@example/one", bundle: "dashboard", file: "index.html" }, OWNER)).json();
  const base = dirname(src);
  for (const escape of ["..%2Fsecret.txt", "..%2F..%2Fsecret.txt", "%2e%2e/secret.txt", "../secret.txt"]) {
    const response = await call(`${base}/${escape}`);
    assert.notEqual(response.status, 200, escape);
    assert.doesNotMatch(await response.text(), /outside the bundle/, escape);
  }
  // Another service's files are not reachable by swapping a name into the path: the claims decide it.
  // The bundle in the path must be the one the token names.
  const wrongBundle = await call(src.replace("/dashboard/", "/elsewhere/"));
  assert.equal(wrongBundle.status, 404);
});

test("a capability never falls back to package-root files or follows a symlink outside its bundle", async (t) => {
  const { call, mint } = await boot(t);
  const { src } = await (await mint({ service: "@example/one", bundle: "dashboard", file: "index.html" }, OWNER)).json();
  for (const file of ["secret.txt", "other/private.txt", "linked.txt", "linked-directory/private.txt"]) {
    const response = await call(`${dirname(src)}/${file}`);
    assert.equal(response.status, 404, file);
    assert.doesNotMatch(await response.text(), /outside the bundle|another bundle/);
  }
  const alias = await (await mint({ service: "@example/one", bundle: "root-alias", file: "secret.txt" }, OWNER)).json();
  assert.equal((await call(alias.src)).status, 404, "a symlink cannot make the package root into a page bundle");
});

test("minting refuses bundle traversal and invalid owner identities", async (t) => {
  const { mint } = await boot(t);
  for (const bundle of ["..", ".", "../other", "dashboard/../other", "/dashboard", "dashboard\\..", "x\0y"]) {
    assert.equal((await mint({ service: "@example/one", bundle, file: "index.html" }, OWNER)).status, 400, bundle);
  }
  for (const service of ["../one", "@example/../one", "@example/one/extra"]) {
    assert.equal((await mint({ service, bundle: "dashboard", file: "index.html" }, OWNER)).status, 400, service);
  }
});

test("a tampered, truncated or foreign token reads nothing", async (t) => {
  const { call, mint } = await boot(t);
  const { src } = await (await mint({ service: "@example/one", bundle: "dashboard", file: "index.html" }, OWNER)).json();
  const token = src.split("/").at(-3);
  const [payload, signature] = token.split(".");
  for (const bad of [`${payload}.${signature.slice(0, -3)}AAA`, `${payload}.`, "garbage", `${payload.slice(0, -2)}AA.${signature}`]) {
    const response = await call(`/zelavis/api/v1/runtime/page-capabilities/${bad}/dashboard/app.js`);
    assert.equal(response.status, 404, bad);
  }
});

test("minting needs a session, and a Project's page needs that Project's view permission", async (t) => {
  const { mint } = await boot(t);
  assert.equal((await mint({ service: "@example/one", file: "index.html" }, {})).status, 401);
  assert.equal((await mint({ service: "@example/one", bundle: "dashboard", file: "index.html" }, VIEWER)).status, 200, "a signed-in caller may mint a Platform page");
  assert.equal((await mint({ service: "@example/one", bundle: "dashboard", file: "index.html", projectId: "p1" }, VIEWER)).status, 403);
  assert.equal((await mint({ service: "@example/one", bundle: "dashboard", file: "index.html", projectId: "p1" }, OWNER)).status, 200);
  assert.equal((await mint({ service: "", file: "index.html" }, OWNER)).status, 400);
  assert.equal((await mint({ service: "@example/one", file: "" }, OWNER)).status, 400);
});

test("a Project's page is requested from its runtime by claims alone, as a principal with no permission", () => {
  const request = projectPageRequest({ service: "@acme/shop", bundle: "dist", projectId: "p1", expiresAt: 0 }, "assets/app.js");
  assert.deepEqual(request, {
    projectId: "p1",
    wildcardPath: "zelavis/api/v1/runtime/service-page-assets/%40acme%2Fshop/dist/assets/app.js",
    principal: { id: "service-page", type: "service" },
    permissions: [],
  });
  // A path cannot add segments or traverse: each segment is encoded.
  assert.equal(projectPageRequest({ service: "@acme/shop", bundle: "dist", projectId: "p1", expiresAt: 0 }, "a b/c%2Fd").wildcardPath.endsWith("/dist/a%20b/c%252Fd"), true);
});

test("the config and the registry listing agree about a service's trust", async (t) => {
  const { call } = await boot(t);
  const config = await (await call("/zelavis/api/v1/runtime/config", undefined, OWNER)).json();
  const registry = await (await call("/zelavis/api/v1/runtime/services", undefined, OWNER)).json();
  const fromConfig = Object.fromEntries(config.services.map((service) => [service.name, service.scope]));
  const fromRegistry = Object.fromEntries(registry.services.map((service) => [service.name, service.scope]));
  // A service the operator passes to zelavis() is composed by the operator, so it is trusted; the frontend the host
  // selected is too. What the dashboard reads in two places must not disagree about one service.
  for (const name of ["@zelavis/ui", "@example/one", "@example/two"]) {
    assert.equal(fromConfig[name], "system", name);
    if (name in fromRegistry) assert.equal(fromRegistry[name], fromConfig[name], `${name}: the registry says what the config says`);
  }
});
