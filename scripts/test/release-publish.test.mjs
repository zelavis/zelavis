import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publisher = resolve(dirname(fileURLToPath(import.meta.url)), "../release-publish.mjs");

function fixture(t, { pre, dirty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "zelavis-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(join(root, "packages/zelavis"), { recursive: true });
  writeFileSync(join(root, "packages/zelavis/package.json"), JSON.stringify({ version: "2.0.0-alpha.12" }));
  if (pre) {
    mkdirSync(join(root, ".changeset"));
    writeFileSync(join(root, ".changeset/pre.json"), JSON.stringify({ mode: "pre", tag: pre }));
  }
  for (const command of ["pnpm", "git", "npm"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ZELAVIS_TEST_COMMAND_LOG, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");
if (${JSON.stringify(command)} === "git" && ${dirty}) process.exit(1);
if (${JSON.stringify(command)} === "npm") process.stdout.write(JSON.stringify({ name: "zelavis", version: "2.0.0-alpha.12", "dist.integrity": "sha512-test" }));
`);
    chmodSync(path, 0o755);
  }
  return (tag) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELAVIS_TEST_COMMAND_LOG: log };
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    const result = spawnSync(process.execPath, [publisher, tag], { cwd: root, env, encoding: "utf8" });
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { ...result, commands };
  };
}

test("manual alpha release publishes directly after validation and ownership checks, then verifies npm", (t) => {
  const result = fixture(t, { pre: "alpha" })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.slice(0, 4), [
    ["pnpm", "release:check"],
    ["git", "diff", "--quiet"],
    ["git", "diff", "--cached", "--quiet"],
    ["pnpm", "-r", "publish", "--tag", "alpha", "--access", "public", "--no-git-checks"],
  ]);
  assert.equal(result.commands[4][0], "npm");
  assert.ok(result.commands[4].includes("zelavis@2.0.0-alpha.12"));
});

test("manual stable releases explicitly publish to latest", (t) => {
  const result = fixture(t)("latest");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.commands.some((command) => command[0] === "pnpm" && command.includes("publish") && command.includes("latest")));
});

test("prerelease mode cannot publish to latest", (t) => {
  const result = fixture(t, { pre: "alpha" })("latest");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Exit prerelease mode/);
  assert.deepEqual(result.commands, [["pnpm", "release:check"]]);
});

test("uncommitted tracked files prevent publication", (t) => {
  const result = fixture(t, { dirty: true })("alpha");
  assert.equal(result.status, 1);
  assert.deepEqual(result.commands, [["pnpm", "release:check"], ["git", "diff", "--quiet"]]);
});
