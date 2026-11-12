import test from "node:test";
import { createRecipeHost } from "../dist/adapters/_recipe-host.js";
import { recipeHostConformance } from "./fixtures/recipe-host-conformance.mjs";

recipeHostConformance(test, (options) => createRecipeHost(options));

// Recipe contract 2: the root is the Platform's own directory, and the application's directory beside it
// is reached by absolute path. Nothing else absolute is, and the secrets stay out of reach.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, succeed } from "./fixtures/recipe-host-conformance.mjs";

test("an absolute path reaches the declared application directory and nothing else", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zelavis-recipe-areas-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, ".zelavis", "server");
  const app = join(base, "app");
  const secretsDirectory = join(base, ".zelavis", "secrets");
  await mkdir(root, { recursive: true });
  await mkdir(join(app, "site"), { recursive: true });
  await mkdir(join(base, "elsewhere"), { recursive: true });
  const host = createRecipeHost({ root, areas: [app], secretsDirectory, commands: { node: process.execPath } });

  await succeed(host.files.write(join(app, "site", "wp-config.php"), "<?php"));
  assert.equal(await readFile(join(app, "site", "wp-config.php"), "utf8"), "<?php");
  await succeed(host.files.write("Caddyfile", ":80"));
  assert.equal(await readFile(join(root, "Caddyfile"), "utf8"), ":80", "relative paths stay in the root");
  await succeed(host.files.write(join(root, "php-fpm.conf"), "[global]"));

  for (const path of [join(base, "elsewhere", "x"), join(secretsDirectory, "db-password"), join(app, "..", "elsewhere", "x"), join(app, "site", "..", "..", "x"), app]) {
    assert.match((await failure(host.files.write(path, "no"))).message, /path|project/i, path);
  }
  await symlink(join(base, "elsewhere"), join(app, "link"));
  assert.match((await failure(host.files.write(join(app, "link", "x"), "no"))).message, /symbolic link/);
  await writeFile(join(base, "elsewhere", "private.txt"), "not yours");
  await failure(host.files.read(join(base, "elsewhere", "private.txt")));
});
