import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { resolveBundledFrontend } from "../dist/cli/bundled-frontend.js";

async function shippedDashboard(t, source = "export const zelavisUiFrontend = () => 'shipped';") {
  const directory = await mkdtemp(join(tmpdir(), "zv-dashboard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "dist", "frontend.js"), source);
  return directory;
}

const importer = (installed) => async (specifier) => {
  if (specifier.startsWith("file:")) return import(specifier);
  if (installed) return { zelavisUiFrontend: () => "installed" };
  throw new Error("Cannot find package '@zelavis/ui'");
};

test("the dashboard shipped in the package's services folder is served, with nothing installed beside it", async (t) => {
  // `npm install zelavis` puts the default services under services/, and no
  // `@zelavis/ui` anywhere Node would resolve it. This is that install.
  const directory = await shippedDashboard(t);
  const factory = await resolveBundledFrontend({
    bundledDirectory: (name) => (name === "@zelavis/ui" ? directory : undefined),
    importer: importer(false),
  });
  assert.equal(factory?.(), "shipped");
});

test("the shipped dashboard wins over an installed one: it is the version released with this Platform", async (t) => {
  const directory = await shippedDashboard(t);
  const factory = await resolveBundledFrontend({ bundledDirectory: () => directory, importer: importer(true) });
  assert.equal(factory?.(), "shipped");
});

test("without a shipped dashboard an installed @zelavis/ui stands in", async () => {
  const factory = await resolveBundledFrontend({ bundledDirectory: () => undefined, importer: importer(true) });
  assert.equal(factory?.(), "installed");
});

test("with neither, there is no dashboard and the Platform serves its placeholder", async () => {
  assert.equal(await resolveBundledFrontend({ bundledDirectory: () => undefined, importer: importer(false) }), undefined);
});

test("a shipped dashboard that fails to load does not take the Platform down", async (t) => {
  const directory = await shippedDashboard(t, "throw new Error('broken build');");
  const factory = await resolveBundledFrontend({ bundledDirectory: () => directory, importer: importer(true) });
  assert.equal(factory?.(), "installed", "falls back rather than failing to start");
  assert.equal(pathToFileURL(directory).protocol, "file:");
});
