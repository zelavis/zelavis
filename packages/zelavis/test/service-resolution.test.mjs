import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Effect } from "effect";
import { createLocalRuntimeServiceImporter } from "../dist/adapters/_local-runtime.js";
import { HOST_PROVIDED_PACKAGES, isHostProvided, unprovidedDependencies } from "../dist/adapters/_service-resolution.js";

async function serviceFolder(t, source) {
  // Under the system temp directory: no node_modules anywhere above it, like
  // /var/lib/zelavis/services, so nothing here can resolve a package by walking up.
  const root = await mkdtemp(join(tmpdir(), "zv-resolution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "services", "probe");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@acme/probe", version: "1.0.0", type: "module" }));
  await writeFile(join(directory, "index.js"), source);
  return { services: join(root, "services"), entry: join(directory, "index.js"), root };
}

test("only zelavis and effect, and their subpaths, are the host's", () => {
  assert.deepEqual([...HOST_PROVIDED_PACKAGES], ["zelavis", "effect"]);
  for (const yes of ["effect", "effect/Schema", "zelavis", "zelavis/sdk", "zelavis/core"]) assert.equal(isHostProvided(yes), true, yes);
  for (const no of ["effectful", "zelavis-extra", "stripe", "@zelavis/ui", "node:fs", "./x.js"]) assert.equal(isHostProvided(no), false, no);
});

test("a service in a services folder gets effect and zelavis from the host, as the same single copy", async (t) => {
  const { services, entry } = await serviceFolder(t, `
    import { Effect } from "effect";
    import * as Schema from "effect/Schema";
    import * as sdk from "zelavis/sdk";
    export { Effect, Schema, sdk };
  `);
  const importer = createLocalRuntimeServiceImporter({ directory: services });
  const loaded = await importer(entry);
  assert.equal(loaded.Effect, Effect, "one Effect: two copies would hold unrelated services and layers");
  assert.equal(typeof loaded.sdk.zelavis, "object");
});

test("anything else a service imports is still its own to carry", async (t) => {
  const { services, entry } = await serviceFolder(t, `import Stripe from "stripe"; export default Stripe;`);
  const importer = createLocalRuntimeServiceImporter({ directory: services });
  await assert.rejects(importer(entry), (error) => error.code === "ERR_MODULE_NOT_FOUND" && /stripe/.test(error.message));
});

test("a Project's bundled Marketplace loads from an unpacked distribution without a zelavis dependency link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zv-unpacked-marketplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await cp(join(source, "dist"), join(root, "dist"), { recursive: true });
  const service = "services/zelavis-marketplace";
  await mkdir(join(root, service), { recursive: true });
  for (const entry of ["dist", "package.json", "allowlist.snapshot.json"]) {
    await cp(join(source, service, entry), join(root, service, entry), { recursive: true });
  }
  // Dependencies are the host's existing copies. Deliberately omit zelavis:
  // npm install inside an unpacked tarball does not link the package to itself.
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(root, "node_modules", name);
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(await realpath(join(source, "node_modules", name)), target);
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createLocalMarketplace } from "./dist/adapters/_marketplace-allowlist.js";
    const marketplace = await createLocalMarketplace({ options: { sources: [] }, bundledNames: new Set(), role: "project", dataDirectory: "." });
    assert.ok(marketplace?.gate);
    assert.equal((await marketplace.client.current()).origin, "bundled");
  `], { cwd: root, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("code outside a services folder is resolved as it always was", async (t) => {
  const { root } = await serviceFolder(t, "export {}");
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "x.mjs"), `import "effect";`);
  // Not under any services folder, so the hook does not apply and Node's own
  // lookup (which finds nothing here) answers.
  await assert.rejects(import(join(elsewhere, "x.mjs")), (error) => error.code === "ERR_MODULE_NOT_FOUND");
});

test("the dependencies a service must carry are the ones the host does not provide", () => {
  assert.deepEqual(unprovidedDependencies({ dependencies: { stripe: "^22", effect: "4.0.0", zelavis: "*", jose: "^6" } }), ["jose", "stripe"]);
  assert.deepEqual(unprovidedDependencies({ dependencies: { effect: "4.0.0" } }), []);
  assert.deepEqual(unprovidedDependencies({ peerDependencies: { stripe: "*" }, devDependencies: { stripe: "*" } }), [], "only runtime dependencies count");
  assert.deepEqual(unprovidedDependencies({}), []);
  assert.deepEqual(unprovidedDependencies(undefined), []);
  assert.deepEqual(unprovidedDependencies({ dependencies: ["stripe"] }), [], "a malformed field is not a list of names");
});
