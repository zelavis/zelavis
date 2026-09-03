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
  const packageDirectory = join(root, "product-services", directoryName);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageDirectory, "index.js"), entry);
}

function servicePackage(name, basePath, body) {
  return `export default {
    name: ${JSON.stringify(name)},
    kind: "plugin",
    basePath: ${JSON.stringify(basePath)},
    capabilities: ["api:routes"],
    api: { v1: [{
      id: "folder.get",
      method: "GET",
      path: "/",
      handler: async () => ({ status: 200, body: ${JSON.stringify(body)} }),
    }] },
  };`;
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
      zelavis: { kind: "plugin", capabilities: ["api:routes"] },
    },
    servicePackage("@acme/hello", "/hello", { hello: "from the folder" }),
  );

  const zv = await runtime(root);
  assert.deepEqual(await get(zv, "/zelavis/api/v1/hello/"), {
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
      name: "zelavis/auth",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin" },
    },
    servicePackage("zelavis/auth", "/pwned", { pwned: true }),
  );

  // Refused before loading. Reaching the activation guard instead throws, so
  // one dropped-in package would stop the Platform from booting at all.
  const zv = await runtime(root);
  const config = await get(zv, "/zelavis/api/v1/runtime/config");
  assert.equal(config.status, 200);
  assert.equal((await get(zv, "/zelavis/api/v1/pwned/")).status, 404);
});

test("a broken package leaves the rest of the installation working", async () => {
  const root = await dataDirectory();
  await dropPackage(
    root,
    "broken",
    { name: "@acme/broken", type: "module", exports: "./index.js", zelavis: { kind: "plugin" } },
    "throw new Error('this package explodes on import');",
  );
  await dropPackage(
    root,
    "working",
    {
      name: "@acme/working",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin", capabilities: ["api:routes"] },
    },
    servicePackage("@acme/working", "/working", { ok: true }),
  );

  const zv = await runtime(root);
  assert.equal((await get(zv, "/zelavis/api/v1/runtime/config")).status, 200);
  assert.deepEqual(await get(zv, "/zelavis/api/v1/working/"), {
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
      zelavis: { kind: "plugin", capabilities: ["api:routes"] },
    },
    servicePackage("@acme/hello", "/hello", { hello: "from the folder" }),
  );

  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, productServices: false }),
  });
  test.after(() => zv.close());
  assert.equal((await get(zv, "/zelavis/api/v1/hello/")).status, 404);
});
