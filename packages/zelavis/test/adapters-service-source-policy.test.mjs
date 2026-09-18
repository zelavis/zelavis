import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalRuntimeServiceImporter } from "../dist/adapters/_local-runtime.js";

test("managed source policy checks physical targets while allowing internal links and explicit filesystem sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-physical-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "services");
  await mkdir(directory);
  const outside = join(root, "outside.mjs");
  await writeFile(outside, "export const location = 'outside';");
  await writeFile(join(directory, "inside.mjs"), "export const location = 'inside';");
  await symlink(outside, join(directory, "escape.mjs"));
  await symlink(join(directory, "inside.mjs"), join(directory, "alias.mjs"));
  const importer = createLocalRuntimeServiceImporter({ directory });
  for (const path of [join(directory, "escape.mjs"), outside]) {
    await assert.rejects(importer(path), /sources\.filesystem/);
    await assert.rejects(importer(pathToFileURL(path).href), /sources\.filesystem/);
  }
  assert.equal((await importer(join(directory, "alias.mjs"))).location, "inside");
  assert.equal((await importer(pathToFileURL(join(directory, "alias.mjs")).href)).location, "inside");
  const explicit = createLocalRuntimeServiceImporter({ directory, sources: { filesystem: true } });
  assert.equal((await explicit(join(directory, "escape.mjs"))).location, "outside");
  const linkedRoot = join(root, "linked-services");
  await symlink(directory, linkedRoot, "dir");
  const linked = createLocalRuntimeServiceImporter({ directory: linkedRoot });
  assert.equal((await linked(join(linkedRoot, "inside.mjs"))).location, "inside");
  assert.equal((await linked(pathToFileURL(await realpath(join(directory, "inside.mjs"))).href)).location, "inside");
});

test("service source policy is opt-in per scheme", async () => {
  const importer = createLocalRuntimeServiceImporter({
    directory: "/tmp/zelavis-source-policy",
  });

  for (const [specifier, expected] of [
    ["https://example.com/service.mjs", /sources\.https/],
    ["http://example.com/service.mjs", /sources\.insecureHttp/],
    ["data:text/javascript,export default {}", /sources\.data/],
    ["file:///etc/passwd", /sources\.filesystem/],
    ["/etc/passwd", /sources\.filesystem/],
    ["./relative.mjs", /sources\.filesystem/],
  ]) {
    await assert.rejects(
      () => importer(specifier),
      expected,
      `${specifier} must be refused by default`,
    );
  }
});

test("plaintext http is gated separately from https", async () => {
  // Enabling HTTPS must not silently enable plaintext transport, where any
  // network position can substitute the code that runs.
  const importer = createLocalRuntimeServiceImporter({
    directory: "/tmp/zelavis-source-policy",
    sources: { https: true },
  });

  await assert.rejects(
    () => importer("http://example.com/service.mjs"),
    /sources\.insecureHttp/,
  );
});

test("enabling https does not enable any other scheme", async () => {
  const importer = createLocalRuntimeServiceImporter({
    directory: "/tmp/zelavis-source-policy",
    sources: { https: true },
  });

  // Each scheme is its own decision. Plaintext transport lets any network
  // position substitute the code that runs, and `data:` carries its payload
  // inline, so neither rides along with https.
  await assert.rejects(
    () => importer("http://example.com/service.mjs"),
    /sources\.insecureHttp/,
  );
  await assert.rejects(
    () => importer("data:text/javascript,export default {}"),
    /sources\.data/,
  );
});
