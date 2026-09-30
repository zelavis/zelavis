// Runs under Bun. Exercises the services model through the Bun adapter and
// prints one JSON document of what it observed; the test asserts on it.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../../dist/index.js";
import { bunAdapter } from "../../dist/adapters/bun.js";

const sdk = new URL("../../dist/sdk/fetch.js", import.meta.url).href;
const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const out = { runtime: typeof Bun === "undefined" ? "not-bun" : "bun" };

async function dropPackage(root, directory, manifest, entry) {
  const dir = join(root, "services", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "index.js"), entry);
}

async function dropFrontend(root, directory, name, html) {
  const dir = join(root, "services", directory);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name, version: "1.0.0", type: "module",
    zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist", mode: "spa" } },
  }));
  await writeFile(join(dir, "dist", "index.html"), html);
}

const text = async (zv, path) => {
  const response = await zv.fetch(new Request(`http://localhost${path}`));
  return { status: response.status, body: await response.text() };
};
const json = async (zv, path, init, context) => {
  const response = await zv.fetch(new Request(`http://localhost${path}`, init), context);
  return { status: response.status, body: await response.json() };
};

const pkg = `import { zelavis } from ${JSON.stringify(sdk)};
  export function register() { zelavis.createAPI({ hello: { list() { return { hello: "from the folder" }; } } }); }`;
const manifest = {
  name: "@acme/hello", type: "module", exports: "./index.js",
  zelavis: { kind: "plugin", namespace: "example", capabilities: ["api:routes"] },
};

// Platform: official catalog, a dropped-in package, a folder frontend under /apps.
{
  const root = await mkdtemp(join(tmpdir(), "zv-bun-platform-"));
  await dropPackage(root, "hello", manifest, pkg);
  await dropFrontend(root, "blog", "@acme/blog-frontend", "<h1>blog</h1>");
  const zv = new Zelavis({ adapter: bunAdapter({ dataDirectory: root }) });
  const config = await json(zv, "/zelavis/api/v1/runtime/config");
  out.platform = {
    registry: config.body.serviceRegistry.map((entry) => `${entry.name}:${entry.status}:${entry.source}`).sort(),
    folderApi: await json(zv, "/zelavis/api/v1/plugins/example/hello"),
    folderFrontend: await text(zv, "/apps/%40acme%2Fblog-frontend/"),
    rootIsNotTheFrontend: !(await text(zv, "/")).body.includes("blog"),
  };
  await zv.close();
}

// Project: its own services folder, its own frontend at "/", selection by install.
{
  const root = await mkdtemp(join(tmpdir(), "zv-bun-project-"));
  await dropPackage(root, "hello", manifest, pkg);
  await dropFrontend(root, "blog", "@acme/blog-frontend", "<h1>first site</h1>");
  await dropFrontend(root, "shop", "@acme/shop-frontend", "<h1>second site</h1>");
  const open = () => new Zelavis({ adapter: bunAdapter({ role: "project", dataDirectory: root }) });
  const zv = open();
  out.project = {
    folderApi: await json(zv, "/zelavis/api/v1/plugins/example/hello"),
    site: (await text(zv, "/")).body,
    apiStillServed: (await json(zv, "/zelavis/api/v1/runtime/config")).status,
  };
  await json(zv, "/zelavis/api/v1/runtime/services/%40acme%2Fshop-frontend", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "installed" }),
  }, OWNER);
  out.project.afterSelect = (await text(zv, "/")).body;
  await zv.close();
  const again = open();
  out.project.afterRestart = (await text(again, "/")).body;
  await again.close();
}

console.log(JSON.stringify(out));
process.exit(0);
