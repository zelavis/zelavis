import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const publisher = new URL("../../scripts/release-publish.mjs", import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-publish-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/zelavis"), { recursive: true });
  await mkdir(join(root, ".changeset"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "temporary"));
  await writeFile(join(root, "packages/zelavis/package.json"), JSON.stringify({ name: "zelavis", version: "2.0.0-alpha.6" }));
  await writeFile(join(root, ".changeset/pre.json"), JSON.stringify({ tag: "alpha" }));
  await writeFile(join(root, "command.cjs"), `
    const fs = require("node:fs");
    const [tool, ...args] = process.argv.slice(2);
    fs.appendFileSync("commands", JSON.stringify({ tool, args }) + "\\n");
    if (tool === "pnpm" && args[0] === "release:check") {
      fs.writeFileSync("auth-mode", String(fs.statSync(process.env.NPM_CONFIG_USERCONFIG).mode & 0o777));
      if (process.env.TEST_FAILURE === "validation") process.exit(42);
    }
    if (tool === "git" && args[0] === "rev-parse") console.log(args.includes("HEAD") || process.env.TEST_FAILURE !== "stale-tag" ? "abc123" : "old123");
    if (tool === "npm") console.log(JSON.stringify({ name: "zelavis", version: process.env.TEST_FAILURE === "npm" ? "2.0.0-alpha.5" : "2.0.0-alpha.6", "dist.integrity": "sha512-YWJjZA==" }));
  `);
  for (const tool of ["pnpm", "git", "npm"]) {
    await writeFile(join(root, "bin", tool), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(root, "command.cjs")}' '${tool}' "$@"\n`);
    await chmod(join(root, "bin", tool), 0o755);
  }
  const run = (failure, tag = "alpha") => spawnSync(process.execPath, [publisher, tag], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: join(root, "bin"), TMPDIR: join(root, "temporary"), NPM_TOKEN: randomBytes(24).toString("hex"), TEST_FAILURE: failure ?? "" } });
  return { root, run };
}

test("publishing requests distribution with only the verified exact Platform tag", async (t) => {
  const { root, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(join(root, "commands"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(commands.slice(0, 2), [{ tool: "pnpm", args: ["release:check"] }, { tool: "pnpm", args: ["changeset", "publish"] }]);
  assert.deepEqual(commands.filter(({ tool, args }) => tool === "git" && args[0] === "push"), [{ tool: "git", args: ["push", "origin", "refs/tags/zelavis@2.0.0-alpha.6"] }]);
  assert.equal(await readFile(join(root, "auth-mode"), "utf8"), String(0o600));
  assert.deepEqual(await readdir(join(root, "temporary")), []);
});

for (const failure of ["validation", "stale-tag", "npm", "prerelease-mode"]) {
  test(`failed ${failure} never requests distribution and removes temporary npm authentication`, async (t) => {
    const { root, run } = await fixture(t);
    const result = run(failure, failure === "prerelease-mode" ? "latest" : "alpha");
    assert.equal(result.status, failure === "validation" ? 42 : 1, result.stderr);
    assert.doesNotMatch(await readFile(join(root, "commands"), "utf8"), /"push"/);
    assert.deepEqual(await readdir(join(root, "temporary")), []);
  });
}
