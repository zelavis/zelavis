// What every RecipeHost adapter must satisfy, whatever it runs on. An adapter's own test calls
// `recipeHostConformance(test, makeHost)`; a new adapter is not accepted until this passes for it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber } from "effect";

const exec = promisify(execFile);

/** The typed failure of an Effect, or a test failure if it succeeded. */
export async function failure(effect) {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected the operation to fail");
  const error = Cause.squash(exit.cause);
  assert.equal(error._tag, "RecipeError", `expected a RecipeError, got ${error?._tag ?? error}`);
  return error;
}
export const succeed = (effect) => Effect.runPromise(effect);

/** `makeHost({ root, secretsDirectory, commands, fetch })` returns the adapter under test. */
export function recipeHostConformance(test, makeHost) {
  async function sandbox(t, extra = {}) {
    const base = await mkdtemp(join(tmpdir(), "zelavis-recipe-host-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "project");
    const secretsDirectory = join(base, "secrets");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "private.txt"), "not yours");
    const progress = [];
    const host = makeHost({
      root, secretsDirectory, commands: { node: process.execPath }, progress: (entry) => progress.push(entry), ...extra,
    });
    return { host, root, secretsDirectory, outside, base, progress };
  }

  test("paths that leave the project, or name nothing, are refused by every file operation", async (t) => {
    const { host } = await sandbox(t);
    const bad = ["", ".", "/etc/passwd", "../x", "a/../../x", "a/../..", "a\\b", "a\0b", "x".repeat(2000)];
    for (const path of bad) {
      assert.match((await failure(host.files.read(path))).message, /path|project|empty/i);
      await failure(host.files.write(path, "x"));
      await failure(host.files.mkdir(path));
      await failure(host.files.remove(path));
      await failure(host.download({ url: "https://example.com/a", sha256: "a".repeat(64), maxBytes: 10, destination: path }));
      await failure(host.extract(path, "out.d"));
    }
  });

  test("a symbolic link is never followed, for reading, writing or as a parent directory", async (t) => {
    const { host, root, outside } = await sandbox(t);
    await symlink(join(outside, "private.txt"), join(root, "link.txt"));
    await symlink(outside, join(root, "linked-dir"));
    assert.match((await failure(host.files.read("link.txt"))).message, /symbolic link/);
    await failure(host.files.write("link.txt", "overwrite"));
    assert.match((await failure(host.files.read("linked-dir/private.txt"))).message, /symbolic link/);
    await failure(host.files.write("linked-dir/new.txt", "planted"));
    await failure(host.files.mkdir("linked-dir/sub"));
    await failure(host.files.remove("linked-dir/private.txt"));
    assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "not yours");
    assert.equal(existsSync(join(outside, "new.txt")), false);
  });

  test("files are written whole and read back; nested directories are made; removal is recursive", async (t) => {
    const { host, root } = await sandbox(t);
    await succeed(host.files.write("a/b/c.txt", "hello"));
    assert.equal(await succeed(host.files.read("a/b/c.txt")), "hello");
    assert.equal(statSync(join(root, "a/b/c.txt")).mode & 0o777, 0o644);
    await succeed(host.files.write("a/b/c.txt", "again"));
    assert.equal(await succeed(host.files.read("a/b/c.txt")), "again");
    await succeed(host.files.mkdir("x/y/z"));
    await succeed(host.files.remove("a"));
    assert.equal(existsSync(join(root, "a")), false);
    await failure(host.files.read("missing.txt"));
    await failure(host.files.write("big.txt", "x".repeat(17 * 1024 * 1024)));
  });

  test("only executables the recipe declared run, with no shell and none of the host's environment", async (t) => {
    process.env.ZELAVIS_HOST_ONLY_VARIABLE = "leaked";
    t.after(() => { delete process.env.ZELAVIS_HOST_ONLY_VARIABLE; });
    const { host } = await sandbox(t);
    for (const command of ["sh", "ls", "../node", "/bin/sh", "node;id", "", "Node"]) await failure(host.run({ command, args: [], timeoutMs: 1000 }));
    const printed = await succeed(host.run({
      command: "node", timeoutMs: 10_000,
      args: ["-e", "console.log(JSON.stringify({ env: process.env, argv: process.argv.slice(1), cwd: process.cwd() }))", "; echo injected", "$HOME", "`id`"],
      env: { FROM_RECIPE: "yes" },
    }));
    const seen = JSON.parse(printed.stdout);
    assert.equal(printed.code, 0);
    assert.equal(seen.env.ZELAVIS_HOST_ONLY_VARIABLE, undefined, "the host's environment does not reach the command");
    assert.equal(seen.env.FROM_RECIPE, "yes");
    assert.deepEqual(seen.argv, ["; echo injected", "$HOME", "`id`"], "arguments arrive exactly as given, never through a shell");
    await failure(host.run({ command: "node", args: [], env: { "BAD NAME": "x" }, timeoutMs: 1000 }));
    await failure(host.run({ command: "node", args: Array.from({ length: 129 }, () => "x"), timeoutMs: 1000 }));
    await failure(host.run({ command: "node", args: [], timeoutMs: 0 }));
    const missing = await sandbox(t, { commands: { node: "/nonexistent/node" } });
    await failure(missing.host.run({ command: "node", args: [], timeoutMs: 1000 }));
  });

  test("a command that outlives its deadline is stopped together with everything it started", async (t) => {
    const { host, base } = await sandbox(t);
    const pidFile = join(base, "grandchild.pid");
    const script = `const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(()=>{},1000);`;
    const error = await failure(host.run({ command: "node", args: ["-e", script], timeoutMs: 700 }));
    assert.match(error.message, /did not finish/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), "the grandchild is gone too");
  });

  test("interrupting a phase stops its command", async (t) => {
    const { host, base } = await sandbox(t);
    const pidFile = join(base, "running.pid");
    const fiber = Effect.runFork(host.run({
      command: "node", timeoutMs: 60_000,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`],
    }));
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), "the command did not outlive the phase");
  });

  test("output is bounded", async (t) => {
    const { host } = await sandbox(t);
    const result = await succeed(host.run({ command: "node", args: ["-e", "process.stdout.write('x'.repeat(2_000_000))"], timeoutMs: 20_000 }));
    assert.ok(result.stdout.length <= 256 * 1024);
  });

  test("a secret is generated once, kept outside the project, private, and only ever passed by reference", async (t) => {
    const { host, root, secretsDirectory } = await sandbox(t);
    const reference = await succeed(host.secret("db-password"));
    assert.deepEqual(reference, { secret: "db-password" });
    const file = join(secretsDirectory, "db-password");
    const value = await readFile(file, "utf8");
    assert.ok(value.length >= 32);
    assert.equal(statSync(file).mode & 0o077, 0, "readable only by its owner");
    assert.equal(statSync(secretsDirectory).mode & 0o077, 0);
    assert.ok(!file.startsWith(root), "outside the project, so no path reaches it");
    await succeed(host.secret("db-password"));
    assert.equal(await readFile(file, "utf8"), value, "asking again for a name resumes it, never regenerates");

    await succeed(host.files.write("config.txt", reference));
    assert.equal(await readFile(join(root, "config.txt"), "utf8"), value);
    assert.equal(statSync(join(root, "config.txt")).mode & 0o077, 0, "a file carrying a secret is private");

    const echoed = await succeed(host.run({ command: "node", args: ["-e", "console.log(process.env.PASSWORD); console.error(process.argv[1])", reference], env: { PASSWORD: reference }, timeoutMs: 10_000 }));
    assert.ok(!echoed.stdout.includes(value) && !echoed.stderr.includes(value), "a secret the command prints is removed from what comes back");
    assert.match(echoed.stdout, /\[secret\]/);

    await failure(host.secret("../escape"));
    await failure(host.secret("Upper"));
    await failure(host.files.read("../secrets/db-password"));
    await failure(host.files.write("x", { secret: "never-generated" }));
  });

  test("progress is bounded and carries no secret", async (t) => {
    const { host, progress, secretsDirectory } = await sandbox(t);
    const reference = await succeed(host.secret("token-a"));
    await succeed(host.files.write("uses-it.txt", reference));
    const value = await readFile(join(secretsDirectory, "token-a"), "utf8");
    await succeed(host.progress({ phase: "install", message: `configured with ${value}` }));
    assert.equal(progress[0].message, "configured with [secret]");
    await succeed(host.progress({ phase: "install", message: "y".repeat(5000) }));
    assert.ok(progress[1].message.length <= 500);
    await failure(host.progress({ phase: 1, message: "x" }));
  });

  function respond(bytes, init = {}) {
    return () => Promise.resolve(new Response(bytes, { status: 200, ...init }));
  }
  const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

  test("a download is https only, bounded, and kept only when it matches the pinned digest", async (t) => {
    const bytes = Buffer.from("release bytes");
    const good = await sandbox(t, { fetch: respond(bytes) });
    await succeed(good.host.download({ url: "https://example.com/a.tar.gz", sha256: digestOf(bytes), maxBytes: 1024, destination: "dl/a.tar.gz" }));
    assert.deepEqual(await readFile(join(good.root, "dl/a.tar.gz")), bytes);

    const requested = [];
    const watching = await sandbox(t, { fetch: (url) => { requested.push(String(url)); return respond(bytes)(); } });
    for (const url of ["http://example.com/a", "ftp://example.com/a", "https://user:pw@example.com/a", "not a url", "file:///etc/passwd"]) {
      await failure(watching.host.download({ url, sha256: digestOf(bytes), maxBytes: 1024, destination: "x" }));
    }
    assert.deepEqual(requested, [], "nothing was requested for an address that is refused");
    for (const sha256 of ["short", "A".repeat(64), "z".repeat(64)]) await failure(watching.host.download({ url: "https://example.com/a", sha256, maxBytes: 1024, destination: "x" }));
    for (const maxBytes of [0, -1, 1.5, 2 * 1024 * 1024 * 1024]) await failure(watching.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes, destination: "x" }));

    const mismatch = await sandbox(t, { fetch: respond(bytes) });
    await failure(mismatch.host.download({ url: "https://example.com/a", sha256: "0".repeat(64), maxBytes: 1024, destination: "bad.bin" }));
    assert.equal(existsSync(join(mismatch.root, "bad.bin")), false, "bytes that do not match are not kept");

    const big = await sandbox(t, { fetch: respond(Buffer.alloc(5000)) });
    await failure(big.host.download({ url: "https://example.com/a", sha256: digestOf(Buffer.alloc(5000)), maxBytes: 1000, destination: "big.bin" }));
    assert.equal(existsSync(join(big.root, "big.bin")), false);

    const declared = await sandbox(t, { fetch: respond(bytes, { headers: { "content-length": "999999999" } }) });
    await failure(declared.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes: 1000, destination: "d.bin" }));

    const failing = await sandbox(t, { fetch: () => Promise.resolve(new Response("nope", { status: 500 })) });
    await failure(failing.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes: 1000, destination: "e.bin" }));
  });

  test("a redirect is followed only to https, a few times", async (t) => {
    const bytes = Buffer.from("through a redirect");
    const sequence = [
      () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a" } }),
      () => new Response(bytes, { status: 200 }),
    ];
    const followed = await sandbox(t, { fetch: () => Promise.resolve(sequence.shift()()) });
    await succeed(followed.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes: 1024, destination: "r.bin" }));

    const downgrade = await sandbox(t, { fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "http://evil.example/a" } })) });
    await failure(downgrade.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes: 1024, destination: "r2.bin" }));

    const loop = await sandbox(t, { fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.com/again" } })) });
    await failure(loop.host.download({ url: "https://example.com/a", sha256: digestOf(bytes), maxBytes: 1024, destination: "r3.bin" }));
  });

  async function archive(base, name, python) {
    const file = join(base, name);
    await exec("python3", ["-I", "-c", `import tarfile, io\nt = tarfile.open(${JSON.stringify(file)}, "w:gz")\n${python}\nt.close()`]);
    return file;
  }
  const add = (name, content = "x") => `i = tarfile.TarInfo(${JSON.stringify(name)}); i.size = ${content.length}; t.addfile(i, io.BytesIO(${JSON.stringify(content)}.encode()))`;

  test("an archive unpacks below the project, optionally without its single top directory", async (t) => {
    const { host, root, base } = await sandbox(t);
    await mkdir(join(root, "dl"), { recursive: true });
    const file = await archive(base, "good.tar.gz", [add("app/index.php", "<?php"), add("app/lib/util.php", "util")].join("\n"));
    await exec("cp", [file, join(root, "dl/good.tar.gz")]);
    await succeed(host.extract("dl/good.tar.gz", "plain"));
    assert.equal(await readFile(join(root, "plain/app/index.php"), "utf8"), "<?php");
    await succeed(host.extract("dl/good.tar.gz", "flat", { stripTopLevel: true }));
    assert.equal(await readFile(join(root, "flat/index.php"), "utf8"), "<?php");
    assert.equal(await readFile(join(root, "flat/lib/util.php"), "utf8"), "util");
    await failure(host.extract("dl/good.tar.gz", "flat"));
    await failure(host.extract("dl/missing.tar.gz", "never"));
    await writeFile(join(root, "dl/archive.zip"), "PK");
    await failure(host.extract("dl/archive.zip", "z"));
    await writeFile(join(root, "dl/broken.tar.gz"), "not gzip");
    await failure(host.extract("dl/broken.tar.gz", "broken"));
    assert.equal(existsSync(join(root, "broken")), false);
  });

  test("an archive that points outside, holds a link, or has no single root is refused and leaves nothing behind", async (t) => {
    const { host, root, base } = await sandbox(t);
    await mkdir(join(root, "dl"), { recursive: true });
    const cases = {
      climbs: [add("../escaped.txt")],
      absolute: [add("/tmp/zelavis-escaped.txt")],
      nested: [add("app/../../escaped.txt")],
      symlink: [add("app/ok.txt"), `i = tarfile.TarInfo("app/link"); i.type = tarfile.SYMTYPE; i.linkname = "/etc"; t.addfile(i)`],
      hardlink: [add("app/ok.txt"), `i = tarfile.TarInfo("app/hard"); i.type = tarfile.LNKTYPE; i.linkname = "app/ok.txt"; t.addfile(i)`],
      device: [add("app/ok.txt"), `i = tarfile.TarInfo("app/dev"); i.type = tarfile.CHRTYPE; t.addfile(i)`],
    };
    for (const [name, lines] of Object.entries(cases)) {
      const file = await archive(base, `${name}.tar.gz`, lines.join("\n"));
      await exec("cp", [file, join(root, `dl/${name}.tar.gz`)]);
      await failure(host.extract(`dl/${name}.tar.gz`, `out-${name}`));
      assert.equal(existsSync(join(root, `out-${name}`)), false, `${name}: nothing is left in place`);
      assert.deepEqual((await exec("ls", [root])).stdout.split("\n").filter((entry) => entry.endsWith(".extracting")), [], `${name}: no staging left`);
    }
    assert.equal(existsSync(join(base, "escaped.txt")), false);
    assert.equal(existsSync("/tmp/zelavis-escaped.txt"), false);
    const two = await archive(base, "two.tar.gz", [add("one/a.txt"), add("two/b.txt")].join("\n"));
    await exec("cp", [two, join(root, "dl/two.tar.gz")]);
    await failure(host.extract("dl/two.tar.gz", "stripped", { stripTopLevel: true }));
    assert.equal(existsSync(join(root, "stripped")), false);
  });
}
