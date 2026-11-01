import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const script = fileURLToPath(new URL("../php-builds/sources-lock.sh", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const KEY = "php-8.4-linux-aarch64";

/** A downloads directory the way static-php-cli leaves it: files, a git checkout and a .lock.json naming them. */
async function downloads(t, { extra = {}, files = { "zlib-1.3.2.tar.gz": "zlib bytes", "apcu.tgz": "apcu bytes" } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zv-sources-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const downloadsDirectory = join(directory, "downloads");
  await mkdir(downloadsDirectory);
  for (const [name, content] of Object.entries(files)) await writeFile(join(downloadsDirectory, name), content);
  await mkdir(join(downloadsDirectory, "libaom"));
  execFileSync("git", ["init", "-q"], { cwd: join(downloadsDirectory, "libaom") });
  await writeFile(join(downloadsDirectory, "libaom", "a.txt"), "a");
  execFileSync("git", ["add", "."], { cwd: join(downloadsDirectory, "libaom") });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "x"], { cwd: join(downloadsDirectory, "libaom") });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(downloadsDirectory, "libaom"), encoding: "utf8" }).trim();
  const entries = {
    zlib: { source_type: "archive", filename: "zlib-1.3.2.tar.gz", move_path: null, lock_as: 1, hash: "x" },
    apcu: { source_type: "archive", filename: "apcu.tgz", move_path: "php-src/ext/apcu", lock_as: 1, hash: "y" },
    libaom: { source_type: "git", dirname: "libaom", move_path: null, lock_as: 1, hash: commit },
    ...extra,
  };
  await writeFile(join(downloadsDirectory, ".lock.json"), JSON.stringify(entries, null, 4));
  return { directory, downloadsDirectory, lock: join(directory, "sources.lock"), commit };
}
const run = (mode, setup) => spawnSync("sh", [script, mode, setup.downloadsDirectory, KEY, setup.lock], { encoding: "utf8" });

test("recording writes one line per source, pinned by SHA-256 or commit", async (t) => {
  const setup = await downloads(t);
  const result = run("update", setup);
  assert.equal(result.status, 0, result.stderr);
  const lines = (await readFile(setup.lock, "utf8")).trim().split("\n");
  assert.deepEqual(lines, [
    `${KEY} apcu apcu.tgz archive ${sha("apcu bytes")} ${"apcu bytes".length} -`,
    `${KEY} libaom libaom git ${setup.commit} - -`,
    `${KEY} zlib zlib-1.3.2.tar.gz archive ${sha("zlib bytes")} ${"zlib bytes".length} -`,
  ]);
});

test("a build whose sources match the lock passes, and one whose archive changed is stopped with the difference", async (t) => {
  const setup = await downloads(t);
  assert.equal(run("update", setup).status, 0);
  const ok = run("check", setup);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /All 3 sources match/);

  await writeFile(join(setup.downloadsDirectory, "zlib-1.3.2.tar.gz"), "zlib bytes, tampered");
  const changed = run("check", setup);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /zlib-1\.3\.2\.tar\.gz/);
  assert.match(changed.stderr, /differ from/);
});

test("a source that moved to a new release or appeared out of nowhere is stopped the same way", async (t) => {
  const setup = await downloads(t);
  assert.equal(run("update", setup).status, 0);
  // The upstream's "latest" moved: a new file name under the same source.
  const moved = await downloads(t, { files: { "zlib-1.3.3.tar.gz": "newer", "apcu.tgz": "apcu bytes" }, extra: { zlib: { source_type: "archive", filename: "zlib-1.3.3.tar.gz", move_path: null, lock_as: 1, hash: "z" } } });
  const result = spawnSync("sh", [script, "check", moved.downloadsDirectory, KEY, setup.lock], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1\.3\.2|1\.3\.3/);
  const added = await downloads(t, { files: { "zlib-1.3.2.tar.gz": "zlib bytes", "apcu.tgz": "apcu bytes", "extra.tgz": "e" }, extra: { extra: { source_type: "archive", filename: "extra.tgz", move_path: null, lock_as: 1, hash: "e" } } });
  assert.equal(spawnSync("sh", [script, "check", added.downloadsDirectory, KEY, setup.lock], { encoding: "utf8" }).status, 1);
});

test("with no lock for this PHP series and platform, a build is refused and told how to start one", async (t) => {
  const setup = await downloads(t);
  const result = run("check", setup);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build once with --update-lock/);
  await writeFile(setup.lock, `php-8.3-linux-aarch64 zlib zlib.tar.gz archive ${"a".repeat(64)} 1 -\n`);
  assert.equal(run("check", setup).status, 1, "another series's lock is no lock for this one");
});

test("recording replaces only its own section and keeps the others", async (t) => {
  const setup = await downloads(t);
  const other = `php-8.3-macos-aarch64 zlib zlib-1.3.1.tar.gz archive ${"b".repeat(64)} 5 -\n`;
  await writeFile(setup.lock, other);
  assert.equal(run("update", setup).status, 0);
  const text = await readFile(setup.lock, "utf8");
  assert.ok(text.includes(other.trim()));
  assert.equal(text.trim().split("\n").length, 4);
  assert.equal(run("update", setup).status, 0);
  assert.equal((await readFile(setup.lock, "utf8")).trim().split("\n").length, 4, "recording twice changes nothing");
});

test("a download description that names a path, or a missing file, is refused", async (t) => {
  const traversal = await downloads(t, { extra: { evil: { source_type: "archive", filename: "../../etc/passwd", move_path: null, lock_as: 1, hash: "x" } } });
  const refused = run("update", traversal);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unusual file name/);
  const missing = await downloads(t, { extra: { gone: { source_type: "archive", filename: "gone.tgz", move_path: null, lock_as: 1, hash: "x" } } });
  const absent = run("update", missing);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /gone\.tgz\) is missing/);
});
