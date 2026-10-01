import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("npm create zelavis runs the same command as npm create @zelavis", async () => {
  const alias = new URL("../bin.js", import.meta.url).pathname;
  const create = JSON.parse(await readFile(new URL("../../create/package.json", import.meta.url), "utf8"));
  const out = execFileSync("node", [alias, "--version"], { encoding: "utf8" }).trim();
  assert.equal(out, create.version);
  assert.match(execFileSync("node", [alias, "--help"], { encoding: "utf8" }), /Create a Zelavis Platform/);
});
