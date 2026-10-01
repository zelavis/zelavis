import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  nextSteps,
  packageManagerFromUserAgent,
  parseArguments,
  projectNameFor,
} from "../dist/index.js";

const versions = JSON.parse(await readFile(new URL("../dist/versions.json", import.meta.url), "utf8"));
const platform = JSON.parse(await readFile(new URL("../../zelavis/package.json", import.meta.url), "utf8"));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-create-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("arguments: a directory, the flags, and refusals that say what was wrong", () => {
  assert.deepEqual(parseArguments([]), { yes: false, install: true, git: true, help: false, version: false });
  assert.deepEqual(
    parseArguments(["my-app", "-y", "--no-install", "--no-git", "--pm", "pnpm"]),
    { directory: "my-app", yes: true, install: false, git: false, packageManager: "pnpm", help: false, version: false },
  );
  assert.throws(() => parseArguments(["--pm", "pip"]), /--pm needs one of/);
  assert.throws(() => parseArguments(["--nope"]), /Unknown option "--nope"/);
  assert.throws(() => parseArguments(["a", "b"]), /Only one directory/);
});

test("the package manager is the one that ran the command", () => {
  assert.equal(packageManagerFromUserAgent("pnpm/9.1.0 npm/? node/v24.0.0 darwin arm64"), "pnpm");
  assert.equal(packageManagerFromUserAgent("bun/1.2.0"), "bun");
  assert.equal(packageManagerFromUserAgent("yarn/4.0.0 npm/? node/v24"), "yarn");
  assert.equal(packageManagerFromUserAgent(undefined), "npm");
  assert.equal(packageManagerFromUserAgent("something-else/1"), "npm");
});

test("a folder name becomes a valid package name", () => {
  assert.equal(projectNameFor("/x/My Cool App!"), "my-cool-app");
  assert.equal(projectNameFor("/x/.hidden"), "hidden");
  assert.equal(projectNameFor("/x/@@@"), "zelavis-platform");
});

test("it writes a project that runs the release it was built with", async (t) => {
  const root = await scratch(t);
  const directory = join(root, "My Platform");
  const project = await createProject({ directory, install: false, git: false, packageManager: "npm" });

  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, "my-platform");
  assert.equal(manifest.dependencies.zelavis, versions.zelavis, "the stamped release");
  assert.equal(manifest.dependencies.zelavis, platform.version, "which is this repository's Zelavis");
  assert.deepEqual(Object.keys(manifest.dependencies), ["zelavis"], "the dashboard and default services ship inside zelavis");
  assert.equal(manifest.engines.node, platform.engines.node);
  assert.match(manifest.scripts.dev, /node_modules\/zelavis\/dist\/cli\.js serve --data-dir \.\/\.zelavis/);
  assert.match(manifest.scripts.dev, /--env-file=\.env/);

  // The first-owner token: long enough for the Platform to accept, unique, and private.
  assert.match(project.token, /^[0-9a-f]{48}$/);
  assert.ok(project.token.length >= 32, "the Platform requires at least 32 characters");
  const env = await readFile(join(directory, ".env"), "utf8");
  assert.ok(env.includes(`ZELAVIS_BOOTSTRAP_TOKEN=${project.token}`));
  if (process.platform !== "win32") assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);

  const ignore = await readFile(join(directory, ".gitignore"), "utf8");
  for (const entry of ["node_modules", ".env", ".zelavis"]) assert.ok(ignore.split("\n").includes(entry), entry);
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /^# my-platform/);

  const other = await createProject({ directory: join(root, "second"), install: false, git: false, packageManager: "npm" });
  assert.notEqual(other.token, project.token, "every project gets its own token");
});

test("it will not write into a folder that already has files", async (t) => {
  const root = await scratch(t);
  const directory = join(root, "taken");
  await mkdir(directory);
  await writeFile(join(directory, "notes.txt"), "mine");
  await assert.rejects(createProject({ directory, install: false, git: false, packageManager: "npm" }), /is not empty/);
  assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "mine", "nothing was touched");

  // An existing but empty folder is fine.
  const empty = join(root, "empty");
  await mkdir(empty);
  await createProject({ directory: empty, install: false, git: false, packageManager: "npm" });
});

test("the next steps name the folder, the install when it was skipped, and where the token is", async (t) => {
  const root = await scratch(t);
  const project = await createProject({ directory: join(root, "p"), install: false, git: false, packageManager: "pnpm" });
  const text = nextSteps(project, "p");
  assert.match(text, /cd p/);
  assert.match(text, /pnpm install/);
  assert.match(text, /pnpm dev/);
  assert.match(text, /\.env/);
  assert.doesNotMatch(text, new RegExp(project.token), "the token is never printed");
  assert.doesNotMatch(nextSteps({ ...project, installed: true }, "."), /cd |install/);
});
