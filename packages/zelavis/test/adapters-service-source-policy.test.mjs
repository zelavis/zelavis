import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { createLocalRuntimeServiceImporter } from "../dist/adapters/_local-runtime.js";

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
