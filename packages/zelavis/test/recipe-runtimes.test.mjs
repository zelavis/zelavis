import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { acquireRuntimes, pruneRuntimeStore, runtimePlatform } from "../dist/adapters/_recipe-runtimes.js";
import { parseRecipeManifest } from "../dist/core/recipe/index.js";

const scratch = async (t) => { const base = await mkdtemp(join(tmpdir(), "zv-runtimes-")); t.after(() => rm(base, { recursive: true, force: true })); return base; };

/** A real .tar.gz holding one executable, and a fetch that serves it from a fake https address. */
async function offered(base, { name = "tool", mode = 0o755, content = "#!/bin/sh\necho built-in-tool\n" } = {}) {
  const source = join(base, "src");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, name), content, { mode });
  const archive = join(base, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, name]);
  const bytes = await readFile(archive);
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }); };
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, fetchImpl, requests: () => requests };
}
const runtime = (download, extra = {}) => [{ command: "tool", version: "1.0.0", downloads: { [runtimePlatform()]: { archive: "https://builds.example/tool.tar.gz", sha256: download.sha256, maxBytes: download.size + 1024, executable: "tool", ...extra } } }];
const acquire = (input) => Effect.runPromise(acquireRuntimes(input));

test("a pinned program is downloaded, verified and unpacked once, and offered as a command", async (t) => {
  const base = await scratch(t);
  const store = join(base, "store");
  const build = await offered(base);
  const commands = await acquire({ runtimes: runtime(build), store, fetch: build.fetchImpl });
  assert.equal(commands.tool, join(store, build.sha256, "tool"));
  assert.equal(execFileSync(commands.tool, { encoding: "utf8" }).trim(), "built-in-tool");
  assert.deepEqual(readdirSync(store), [build.sha256], "nothing but the finished unpack is left");
  const again = await acquire({ runtimes: runtime(build), store, fetch: build.fetchImpl });
  assert.deepEqual(again, commands);
  assert.equal(build.requests(), 1, "a second Project pinning the same build downloads nothing");
});

test("two Projects asking at the same moment download the build once", async (t) => {
  const base = await scratch(t);
  const store = join(base, "store");
  const build = await offered(base);
  const [first, second] = await Promise.all([1, 2].map(() => acquire({ runtimes: runtime(build), store, fetch: build.fetchImpl })));
  assert.deepEqual(first, second);
  assert.equal(build.requests(), 1);
});

test("a download that is not the pinned build is refused and leaves nothing", async (t) => {
  const base = await scratch(t);
  const store = join(base, "store");
  const build = await offered(base);
  const pinned = { ...build, sha256: "0".repeat(64) };
  await assert.rejects(acquire({ runtimes: runtime(pinned), store, fetch: build.fetchImpl }), /does not match the SHA-256/);
  assert.deepEqual(readdirSync(store), [], "neither the archive nor a half-unpacked folder remains");
});

test("a mirror serves the build when the official origin fails, and a mirror's different bytes are refused", async (t) => {
  const base = await scratch(t);
  const store = join(base, "store");
  const build = await offered(base);
  const asked = [];
  const routed = async (url) => {
    asked.push(new URL(String(url)).host);
    return String(url).includes("official") ? new Response("blocked", { status: 403 }) : build.fetchImpl();
  };
  const mirrored = runtime(build, { archive: "https://official.example/tool.tar.gz", mirrors: ["https://mirror.example/tool.tar.gz"] });
  const commands = await acquire({ runtimes: mirrored, store, fetch: routed, });
  assert.equal(commands.tool, join(store, build.sha256, "tool"));
  assert.deepEqual(asked, ["official.example", "mirror.example"], "official first, then the mirror");

  const other = join(base, "other");
  const tampering = async (url) => String(url).includes("official") ? new Response("blocked", { status: 403 }) : new Response("not the build", { status: 200 });
  await assert.rejects(acquire({ runtimes: mirrored, store: other, fetch: tampering }), /official\.example.*mirror\.example/s);
  await mkdir(other, { recursive: true });
  assert.deepEqual(readdirSync(other), [], "nothing from a wrong mirror is kept");
});

test("a host without a build, and an archive without its program, are refused by name", async (t) => {
  const base = await scratch(t);
  const store = join(base, "store");
  const build = await offered(base);
  await assert.rejects(acquire({ runtimes: runtime(build), store, platform: "linux-riscv64", fetch: build.fetchImpl }), /tool 1\.0\.0 has no build for linux-riscv64/);
  assert.equal(build.requests(), 0, "nothing is fetched for a platform it was not pinned for");
  await assert.rejects(acquire({ runtimes: runtime(build, { executable: "missing" }), store, fetch: build.fetchImpl }), /does not hold missing/);
  assert.deepEqual(readdirSync(store), [], "an archive that lacks its program is not kept");
  const notExecutable = await offered(await scratch(t), { mode: 0o644 });
  await assert.rejects(acquire({ runtimes: runtime(notExecutable), store, fetch: notExecutable.fetchImpl }), /does not hold tool/);
  assert.equal(existsSync(join(store, notExecutable.sha256)), false);
});

test("a manifest's runtimes name known platforms and one program per command", () => {
  const base = { contract: 1, methods: [{ id: "native", driver: "js", entry: "./dist/r.mjs", requires: [] }], software: [{ version: "1.0", archive: "https://example.com/a.tgz", sha256: "a".repeat(64), maxBytes: 10 }], ports: [] };
  const download = { archive: "https://builds.example/php.tar.gz", sha256: "b".repeat(64), maxBytes: 100, executable: "php" };
  const parse = (runtimes) => parseRecipeManifest({ ...base, runtimes });
  assert.equal(parse([{ command: "php", version: "8.4.23", downloads: { "linux-x86_64": download } }]).runtimes[0].command, "php");
  for (const bad of [
    [{ command: "php", version: "8.4.23", downloads: { "plan9-mips": download } }],
    [{ command: "php", version: "8.4.23", downloads: {} }],
    [{ command: "php", version: "8.4.23", downloads: { "linux-x86_64": { ...download, archive: "http://builds.example/php.tar.gz" } } }],
    [{ command: "php", version: "8.4.23", downloads: { "linux-x86_64": { ...download, executable: "../php" } } }],
    [{ command: "php", version: "8", downloads: { "linux-x86_64": download } }],
    [{ command: "php", version: "8.4.23", downloads: { "linux-x86_64": download } }, { command: "php", version: "8.3.1", downloads: { "linux-x86_64": download } }],
  ]) assert.throws(() => parse(bad), undefined, JSON.stringify(bad).slice(0, 80));
});

test("a build no Project names any more is pruned once it is old enough; named and recent ones stay", async (t) => {
  const base = await scratch(t);
  const store = join(base, "runtimes"), projects = join(base, "projects");
  const digest = (character) => character.repeat(64);
  for (const character of "abcdef") await mkdir(join(store, digest(character)), { recursive: true });
  await mkdir(join(store, "not-a-build"), { recursive: true });
  const reach = (character) => join(store, digest(character), "tool");
  // a is a Project's current program; b is where an unfinished upgrade came from; c is where it is going.
  await mkdir(join(projects, "one", ".zelavis", "upgrade"), { recursive: true });
  await writeFile(join(projects, "one", ".zelavis", "recipe-state.json"), JSON.stringify({ commands: { tool: reach("a"), node: "/usr/bin/node" } }));
  await writeFile(join(projects, "one", ".zelavis", "upgrade", "journal.json"), JSON.stringify({ previousCommands: { tool: reach("b") }, commands: { tool: reach("c") } }));
  await mkdir(join(projects, "two", ".zelavis"), { recursive: true });
  await writeFile(join(projects, "two", ".zelavis", "recipe-state.json"), "not json");
  const later = Date.now() + 3_600_000;
  const removed = await Effect.runPromise(pruneRuntimeStore({ store, projects, now: later }));
  assert.deepEqual([...removed].sort(), [digest("d"), digest("e"), digest("f")]);
  assert.deepEqual(readdirSync(store).sort(), [digest("a"), digest("b"), digest("c"), "not-a-build"], "named builds and foreign folders stay");
  // Nothing unpacked a moment ago is touched, named or not: its Project state may not be written yet.
  await mkdir(join(store, digest("9")), { recursive: true });
  assert.deepEqual(await Effect.runPromise(pruneRuntimeStore({ store, projects })), []);
  assert.ok(existsSync(join(store, digest("9"))));
});

test("a package set is not offered where the recipe brings what it would install", async () => {
  const { neededHostPackages } = await import("../dist/project-host-packages.js");
  const database = ["mariadbd", "mariadb"].map((command) => ({ command, hostRequirement: "mariadb", methods: ["native"], downloads: { "linux-x86_64": {} } }));
  const php = [{ command: "php", downloads: { "linux-x86_64": {}, "linux-aarch64": {} } }];
  const methods = [{ id: "native" }, { id: "container", containers: { database: "mariadb@sha256:" + "a".repeat(64) } }];
  const install = { methods, runtimes: [...php, ...database] };
  assert.deepEqual(neededHostPackages(["mariadb-server"], install, "linux-x86_64"), [], "built here: nothing to install");
  assert.deepEqual(neededHostPackages(["mariadb-server"], install, "linux-aarch64"), ["mariadb-server"], "no build here: the host's package is still needed");
  assert.deepEqual(neededHostPackages(["mariadb-server"], install, "linux-aarch64", "container"), [], "the container method needs no host database anywhere");
  assert.deepEqual(neededHostPackages(["mariadb-server"], install, undefined), ["mariadb-server"]);
  assert.deepEqual(neededHostPackages(["mariadb-server"], { methods }, "linux-x86_64"), ["mariadb-server"], "a recipe that brings nothing needs it");
  assert.deepEqual(neededHostPackages(["wordpress-stack"], install, "linux-x86_64"), ["wordpress-stack"], "a set that also provides nginx and php-fpm is still needed");
});
