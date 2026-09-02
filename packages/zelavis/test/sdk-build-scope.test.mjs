import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONFIGS = ["tsconfig.sdk.node.json", "tsconfig.sdk.browser.json", "tsconfig.bootstrap.json"];

test("a focused tsconfig clears the inherited include", async () => {
  for (const name of CONFIGS) {
    const raw = await readFile(
      fileURLToPath(new URL(`../${name}`, import.meta.url)),
      "utf8",
    );
    // Strip comments; these configs are documented inline.
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

    // `files` and `include` are additive. A config that names one entry file
    // and inherits `include: ["src/**/*"]` compiles the whole package, which
    // is what these three did — quietly, since the output was still correct,
    // just far larger than the config describes.
    assert.ok(Array.isArray(config.files) && config.files.length > 0, name);
    assert.deepEqual(config.include, [], `${name} must clear include`);
    assert.equal(config.extends, "./tsconfig.json", name);
  }
});
