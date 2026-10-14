import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  { dir: "zelavis-services/wiki", manifest: { name: "@zelavis/wiki", version: "1.0.0", peerDependencies: { zelavis: "workspace:*" } } },
  { dir: "website", manifest: { name: "@zelavis/website", version: "0.0.1", private: true } },
];

const HEAD = "4ead9a1c4a0000000000000000000000000000aa";

function fixture(t, { pre, dirty = false, published = ["@zelavis/wiki@1.0.0"], keepWorkspaceRanges = false, qualified, listed = "match" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "zelavis-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "commands.jsonl");
  const premade = join(root, "premade");
  mkdirSync(bin);
  mkdirSync(premade);
  const listing = WORKSPACE.map(({ dir, manifest }) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
    return { name: manifest.name, version: manifest.version, path: join(root, dir), private: manifest.private === true };
  });
  // Each package packs to one fixed tarball, as pnpm's deterministic pack does: workspace ranges become the
  // exact version of the package they name, unless the case is one that keeps them.
  const digests = {};
  for (const { manifest } of WORKSPACE.filter(({ manifest }) => !manifest.private)) {
    const packed = structuredClone(manifest);
    for (const field of ["dependencies", "peerDependencies"]) for (const [name, range] of Object.entries(packed[field] ?? {}))
      if (!keepWorkspaceRanges && range.startsWith("workspace:")) packed[field][name] = listing.find((entry) => entry.name === name).version;
    const staging = mkdtempSync(join(tmpdir(), "zelavis-pack-"));
    mkdirSync(join(staging, "package"));
    writeFileSync(join(staging, "package", "package.json"), JSON.stringify(packed));
    const file = join(premade, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`);
    execFileSync("tar", ["-czf", file, "-C", staging, "package"]);
    rmSync(staging, { recursive: true, force: true });
    digests[manifest.name] = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
  }
  // The shipped allow-list, naming the service with the digest of its pack, a wrong one, or not at all.
  const snapshotDirectory = join(root, "packages/zelavis/services/zelavis-marketplace");
  mkdirSync(snapshotDirectory, { recursive: true });
  const wiki = { "match": digests["@zelavis/wiki"], "wrong": `sha512-${"A".repeat(86)}==` }[listed];
  writeFileSync(join(snapshotDirectory, "allowlist.snapshot.json"), JSON.stringify({
    services: wiki ? [{ name: "@zelavis/wiki", versions: [{ version: "1.0.0", integrity: wiki }] }] : [],
  }));
  if (pre) {
    mkdirSync(join(root, ".changeset"));
    writeFileSync(join(root, ".changeset/pre.json"), JSON.stringify({ mode: "pre", tag: pre }));
  }
  const stub = (command, body) => {
    const path = join(bin, command);
    writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.ZELAVIS_TEST_COMMAND_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + "\\n");
${body}
`);
    chmodSync(path, 0o755);
  };
  stub("git", `if (args[0] === "rev-parse") process.stdout.write(${JSON.stringify(HEAD)});
else if (${dirty}) process.exit(1);`);
  stub("pnpm", `
if (args[0] === "ls") process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
if (args[0] === "pack") {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const file = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz";
  copyFileSync(join(${JSON.stringify(premade)}, file), join(args[args.indexOf("--pack-destination") + 1], file));
}`);
  stub("npm", `
if (args[0] === "view") {
  if (!${JSON.stringify(published)}.includes(args[1])) process.exit(1);
  process.stdout.write(args[1].slice(args[1].lastIndexOf("@") + 1));
}`);
  return (tag, ...flags) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELAVIS_TEST_COMMAND_LOG: log };
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    delete env.ZELAVIS_RELEASE_QUALIFIED;
    if (qualified) env.ZELAVIS_RELEASE_QUALIFIED = qualified;
    const result = spawnSync(process.execPath, [publisher, tag, ...flags], { cwd: root, env, encoding: "utf8" });
    const commands = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const publishes = commands.filter(([command, action]) => command === "npm" && action === "publish");
    return { ...result, commands, publishes };
  };
}

const tarballOf = (publish) => publish[2].split("/").at(-1);

test("an alpha release packs with pnpm and publishes with npm, only what npm lacks, the Platform first", (t) => {
  const result = fixture(t, { pre: "alpha" })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.slice(0, 4), [
    ["git", "rev-parse", "HEAD"],
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
  assert.equal(result.commands.at(-1)[1], "publish", "nothing waits for npm to list what was published");
  assert.match(result.stdout, /Published zelavis@2\.0\.0-alpha\.12 \(sha512-/);
});

test("changed services are published in the same run as the Platform, each checked against the shipped allow-list", (t) => {
  const result = fixture(t, { pre: "alpha", published: [] })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publishes.map(tarballOf), ["zelavis-2.0.0-alpha.12.tgz", "zelavis-app-1.0.1-alpha.12.tgz", "zelavis-wiki-1.0.0.tgz"]);
});

test("a service whose tarball is not the one the allow-list names stops the release before anything is published", (t) => {
  const result = fixture(t, { pre: "alpha", published: [], listed: "wrong" })("alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@zelavis\/wiki@1\.0\.0 packs to sha512-.*but the allow-list names.*pnpm allowlist update/s);
  assert.equal(result.publishes.length, 0);
});

test("a service the allow-list does not name stops the release before anything is published", (t) => {
  const result = fixture(t, { pre: "alpha", published: [], listed: "missing" })("alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allow-list does not name @zelavis\/wiki@1\.0\.0/);
  assert.equal(result.publishes.length, 0);
});

test("a changed service is never published without the Platform that ships its listing", (t) => {
  const result = fixture(t, { pre: "alpha", published: ["zelavis@2.0.0-alpha.12", "@zelavis/app@1.0.1-alpha.12"] })("alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version zelavis too/);
  assert.equal(result.publishes.length, 0);
});

test("the retired services phase is refused rather than ignored", (t) => {
  const result = fixture(t, { pre: "alpha" })("alpha", "--services");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected argument "--services"/);
  assert.equal(result.publishes.length, 0);
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
  assert.deepEqual(result.commands, [["git", "rev-parse", "HEAD"], ["pnpm", "release:check"]]);
});

test("uncommitted tracked files prevent publication", (t) => {
  const result = fixture(t, { dirty: true })("alpha");
  assert.equal(result.status, 1);
  assert.deepEqual(result.commands, [["git", "rev-parse", "HEAD"], ["pnpm", "release:check"], ["git", "diff", "--quiet"]]);
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

test("a commit release:check already qualified is published without running the checks again", (t) => {
  const result = fixture(t, { pre: "alpha", qualified: HEAD })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.commands.some(([command, action]) => command === "pnpm" && action === "release:check"));
  assert.ok(result.commands.some(([command, action]) => command === "git" && action === "diff"), "the tree is still required to be clean");
  assert.equal(result.publishes.length, 2);
});

test("a qualification of another commit does not count", (t) => {
  const result = fixture(t, { pre: "alpha", qualified: "0000000000000000000000000000000000000000" })("alpha");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.commands.some(([command, action]) => command === "pnpm" && action === "release:check"));
  assert.match(result.stdout, /not 4ead9a1c4a/);
});
