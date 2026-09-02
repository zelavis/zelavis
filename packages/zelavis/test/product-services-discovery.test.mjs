import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProductServices,
  PRODUCT_SERVICES_DIRECTORY,
} from "../dist/adapters/_local-runtime.js";

async function folder() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-product-services-"));
  const directory = join(root, PRODUCT_SERVICES_DIRECTORY);
  await mkdir(directory, { recursive: true });
  test.after(() => rm(root, { recursive: true, force: true }));
  return directory;
}

async function writePackage(directory, name, manifest, entry) {
  const packageDirectory = join(directory, name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: `@acme/${name.replace(/[@/]/gu, "-")}`, type: "module", ...manifest }),
  );
  if (entry) {
    await writeFile(join(packageDirectory, "index.js"), entry);
  }
  return packageDirectory;
}

async function discover(directory) {
  const skipped = [];
  const discovered = await discoverProductServices({
    directory,
    onSkipped: (name, reason) => skipped.push({ name, reason }),
  });
  return { discovered, skipped };
}

const VALID = {
  exports: "./index.js",
  zelavis: { kind: "plugin", capabilities: ["api:routes"] },
};

test("a missing folder is the normal empty case, not a failure", async () => {
  const { discovered, skipped } = await discover(
    join(tmpdir(), "zelavis-product-services-does-not-exist"),
  );
  assert.deepEqual(discovered, []);
  assert.deepEqual(skipped, []);
});

test("a package dropped into the folder is discovered", async () => {
  const directory = await folder();
  await writePackage(directory, "hello", VALID, "export default {};");

  const { discovered } = await discover(directory);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].status, "installed");
  assert.match(discovered[0].specifier, /hello\/index\.js$/u);
  // The entry the scan resolved, not the relative string from the manifest:
  // plugin loading imports `exports` verbatim, so a relative value would
  // resolve against the Platform's working directory instead.
  assert.equal(discovered[0].manifest.exports, discovered[0].specifier);
});

test("an exports path escaping its package is refused", async () => {
  const directory = await folder();
  await writePackage(directory, "escape", {
    exports: "../../../../etc/passwd",
    zelavis: { kind: "plugin" },
  });

  const { discovered, skipped } = await discover(directory);
  assert.deepEqual(discovered, []);
  assert.match(skipped[0].reason, /outside the package directory/u);
});

test("an invalid capability is refused at discovery, not silently ignored", async () => {
  const directory = await folder();
  await writePackage(
    directory,
    "badcap",
    { exports: "./index.js", zelavis: { kind: "plugin", capabilities: ["NotValid"] } },
    "export default {};",
  );

  const { discovered, skipped } = await discover(directory);
  assert.deepEqual(discovered, []);
  // A mistyped capability would otherwise install cleanly and then never be
  // found by the plugin it meant to extend.
  assert.match(skipped[0].reason, /not a valid capability/u);
});

test("a package whose entry file is missing is refused", async () => {
  const directory = await folder();
  await writePackage(directory, "ghost", VALID);

  const { discovered, skipped } = await discover(directory);
  assert.deepEqual(discovered, []);
  assert.match(skipped[0].reason, /does not exist/u);
});

test("one broken package does not hide the working ones", async () => {
  const directory = await folder();
  await writePackage(directory, "good", VALID, "export default {};");
  await writePackage(directory, "broken", { zelavis: { kind: "nonsense" } });
  await writePackage(directory, "alsogood", VALID, "export default {};");

  const { discovered, skipped } = await discover(directory);
  assert.equal(discovered.length, 2);
  assert.equal(skipped.length, 1);
});

test("scoped packages are found one level deeper, as in node_modules", async () => {
  const directory = await folder();
  await writePackage(directory, join("@scoped", "theme"), VALID, "export default {};");

  const { discovered } = await discover(directory);
  assert.equal(discovered.length, 1);
  assert.match(discovered[0].specifier, /@scoped\/theme\/index\.js$/u);
});

test("node_modules and dotfiles inside the folder are not scanned", async () => {
  const directory = await folder();
  await writePackage(directory, "node_modules", VALID, "export default {};");
  await writePackage(directory, ".cache", VALID, "export default {};");

  const { discovered, skipped } = await discover(directory);
  assert.deepEqual(discovered, []);
  assert.deepEqual(skipped, []);
});
