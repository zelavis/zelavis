import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publisher = resolve(dirname(fileURLToPath(import.meta.url)), "../release-publish.mjs");

// A workspace of two packages to release (the app names the Platform through a workspace range),
// one already on npm and one private.
const WORKSPACE = [
  { dir: "packages/app", manifest: { name: "@zelavis/app", version: "1.0.1-alpha.12", peerDependencies: { zelavis: "workspace:*" } } },
  { dir: "packages/zelavis", manifest: { name: "zelavis", version: "2.0.0-alpha.12" } },
  { dir: "services/wiki", manifest: { name: "@zelavis/wiki", version: "1.0.0", peerDependencies: { zelavis: "workspace:*" } } },
  { dir: "website", manifest: { name: "@zelavis/website", version: "0.0.1", private: true } },
];

function fixture(t, { pre, dirty = false, published = ["@zelavis/wiki@1.0.0"], keepWorkspaceRanges = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "zelavis-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "commands.jsonl");
  mkdirSync(bin);
  const listing = WORKSPACE.map(({ dir, manifest }) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
    return { name: manifest.name, version: manifest.version, path: join(root, dir), private: manifest.private === true };
  });
  if (pre) {
    mkdirSync(join(root, ".changeset"));
    writeFileSync(join(root, ".changeset/pre.json"), JSON.stringify({ mode: "pre", tag: pre }));
  }
  const stub = (command, body) => {
    const path = join(bin, command);
    writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
const args = process.argv.slice(2);
appendFileSync(process.env.ZELAVIS_TEST_COMMAND_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + "\\n");
${body}
`);
    chmodSync(path, 0o755);
  };
  stub("git", `if (${dirty}) process.exit(1);`);
  stub("pnpm", `
if (args[0] === "ls") process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
if (args[0] === "pack") {
  // Like pnpm: workspace ranges become the exact version of the package they name.
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  for (const field of ["dependencies", "peerDependencies"]) for (const [name, range] of Object.entries(manifest[field] ?? {}))
    if (!${keepWorkspaceRanges} && range.startsWith("workspace:")) manifest[field][name] = ${JSON.stringify(listing)}.find((entry) => entry.name === name).version;
  const staging = mkdtempSync(join(tmpdir(), "zelavis-pack-"));
  mkdirSync(join(staging, "package"));
  writeFileSync(join(staging, "package", "package.json"), JSON.stringify(manifest));
  const destination = args[args.indexOf("--pack-destination") + 1];
  execFileSync("tar", ["-czf", join(destination, manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz"), "-C", staging, "package"]);
}`);
  stub("npm", `
if (args[0] === "view" && args.includes("--json")) process.stdout.write(JSON.stringify({ name: "zelavis", version: "2.0.0-alpha.12", "dist.integrity": "sha512-test" }));
else if (args[0] === "view") {
  if (!${JSON.stringify(published)}.includes(args[1])) process.exit(1);
  process.stdout.write(args[1].slice(args[1].lastIndexOf("@") + 1));
}`);
  return (tag) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELAVIS_TEST_COMMAND_LOG: log };
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    const result = spawnSync(process.execPath, [publisher, tag], { cwd: root, env, encoding: "utf8" });
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const publishes = commands.filter(([command, action]) => command === "npm" && action === "publish");
    return { ...result, commands, publishes };
  };
}

const tarballOf = (publish) => publish[2].split("/").at(-1);

test("an alpha release packs with pnpm and publishes with npm, only what npm lacks, the Platform first", (t) => {
  const result = fixture(t, { pre: "alpha" })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.slice(0, 3), [
    ["pnpm", "release:check"],
    ["git", "diff", "--quiet"],
    ["git", "diff", "--cached", "--quiet"],
  ]);
  assert.deepEqual(result.publishes.map(tarballOf), ["zelavis-2.0.0-alpha.12.tgz", "zelavis-app-1.0.1-alpha.12.tgz"],
    "the already published package is skipped, the private one never considered, and the Platform goes first");
  for (const publish of result.publishes) {
    assert.deepEqual(publish.slice(3), ["--tag", "alpha", "--access", "public", "--registry=https://registry.npmjs.org"]);
  }
  assert.ok(!result.commands.some(([command, action]) => command === "pnpm" && action === "publish"), "pnpm never publishes");
  const packs = result.commands.filter(([command, action]) => command === "pnpm" && action === "pack");
  const firstPublish = result.commands.findIndex(([command, action]) => command === "npm" && action === "publish");
  assert.ok(result.commands.lastIndexOf(packs.at(-1)) < firstPublish, "everything is packed before anything is published");
  assert.ok(result.commands.at(-1).includes("zelavis@2.0.0-alpha.12"), "and npm is asked for the Platform last");
});

test("stable releases publish to latest", (t) => {
  const result = fixture(t)("latest");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.publishes.length > 0 && result.publishes.every((publish) => publish.includes("latest")));
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

test("a packed package that still names a workspace range stops the release before anything is published", (t) => {
  const result = fixture(t, { pre: "alpha", keepWorkspaceRanges: true })("alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still names workspace ranges: zelavis/);
  assert.equal(result.publishes.length, 0);
});

test("with every version already on npm, nothing is published", (t) => {
  const result = fixture(t, { pre: "alpha", published: ["zelavis@2.0.0-alpha.12", "@zelavis/app@1.0.1-alpha.12", "@zelavis/wiki@1.0.0"] })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishes.length, 0);
  assert.match(result.stdout, /nothing to publish/);
});
