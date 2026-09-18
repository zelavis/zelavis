/**
 * What a consumer receives from `npm install zelavis`.
 *
 * Every other test in this suite imports `../dist/...` directly, so it passes
 * whether or not those files were ever published. This one packs the real
 * tarball and works only with what came out of it, which is the one way to
 * catch the mistakes that are invisible until someone installs the package:
 * an `exports` subpath pointing at a file `files` never included, a `.d.ts`
 * the build did not emit, a `bin` that ships but cannot run.
 *
 * The package has 35 export subpaths. Nothing else checks that they all still
 * lead somewhere.
 *
 * The consumer-facing half is deliberately written the way an external
 * verification tool would run it — pack, populate an isolated consumer, import
 * by package name — so it can be lifted out of this suite later without being
 * rewritten.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, constants, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Everything below reads from here, never from the source tree. */
let unpacked;
let manifest;
let consumer;
let workRoot;

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "zelavis-published-"));

  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--pack-destination", workRoot, "--ignore-scripts"],
    { cwd: packageDir, timeout: 300_000 },
  );
  const tarball = join(workRoot, stdout.trim().split("\n").pop().trim());

  unpacked = join(workRoot, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await execFileAsync("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components", "1"], {
    timeout: 300_000,
  });

  manifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));

  // An isolated consumer: the package copied in as a package manager would
  // install it (copied, not linked — Node resolves a module's realpath before
  // looking for `node_modules`, so a symlinked package cannot see its own
  // dependencies), with its declared dependencies linked from this checkout.
  consumer = join(workRoot, "consumer");
  const nodeModules = join(consumer, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "zelavis-consumer", private: true, type: "module" }),
    ),
  );
  await cp(unpacked, join(nodeModules, "zelavis"), { recursive: true });

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const resolved = await resolveInstalled(name, packageDir);
    if (!resolved) continue;
    const linkPath = join(nodeModules, ...name.split("/"));
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(resolved, linkPath).catch(() => undefined);
  }
});

after(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

/** Finds an installed package by walking `node_modules` up from a directory. */
async function resolveInstalled(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

async function shipped(relativePath) {
  try {
    await access(join(unpacked, relativePath), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

test("every exports subpath leads to a file that was published", async () => {
  const missing = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    for (const [condition, file] of Object.entries(target)) {
      if (typeof file !== "string") continue;
      if (!(await shipped(file))) missing.push(`${subpath} (${condition}) -> ${file}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these exports point at files missing from the tarball:\n  ${missing.join("\n  ")}`,
  );
});

test("type declarations ship for every subpath that promises them", async () => {
  // A missing .d.ts does not fail at runtime; TypeScript consumers silently
  // fall back to `any`, which no runtime test would notice.
  const withoutTypes = Object.entries(manifest.exports ?? {})
    .filter(([, target]) => typeof target?.types !== "string")
    .map(([subpath]) => subpath);
  assert.deepEqual(withoutTypes, [], `subpaths declaring no types: ${withoutTypes.join(", ")}`);
});

test("everything `files` promises is actually in the tarball", async () => {
  for (const entry of manifest.files ?? []) {
    assert.equal(await shipped(entry), true, `"${entry}" is listed in files but was not published`);
  }
  // `services` carries the product services the Platform mounts; an empty
  // directory would pass a existence check while shipping nothing.
  const services = await readdir(join(unpacked, "services")).catch(() => []);
  assert.equal(services.length > 0, true, "services/ shipped but is empty");
});

test("the package loads from the tarball in a bare consumer", async () => {
  // Resolution is not loading: a subpath can resolve to a file that throws on
  // import. This is the check a consumer performs by running their code.
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", "const m = await import('zelavis'); console.log(typeof m.Zelavis);"],
    { cwd: consumer, timeout: 120_000 },
  );
  assert.equal(stdout.trim(), "function", "the package entry point did not export Zelavis");
});

test("runtime-neutral subpaths load without the optional engines", async () => {
  // These must not drag in a peer dependency. The DB engine subpaths
  // deliberately are not listed: `libsql`, `lmdb`, `rocksdb` and friends are
  // peer dependencies, so a consumer that has not installed them should fail
  // to import those, and that is correct behaviour rather than a defect.
  for (const subpath of ["zelavis/core", "zelavis/sdk", "zelavis/sdk/browser", "zelavis/service"]) {
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(subpath)});`],
      { cwd: consumer, timeout: 120_000 },
    );
  }
});

test("the published CLI runs from the tarball", async () => {
  const bin = manifest.bin?.zelavis;
  assert.ok(bin, "the package declares no zelavis bin");
  assert.equal(await shipped(bin), true, `${bin} is declared as bin but was not published`);

  // File presence is not enough: a bin importing something `files` excluded
  // exists and still fails on first use.
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(consumer, "node_modules", "zelavis", bin), "--version"],
    { cwd: consumer, timeout: 120_000 },
  );
  assert.match(stdout, /\d+\.\d+\.\d+/u, "the CLI did not print a version");
});
