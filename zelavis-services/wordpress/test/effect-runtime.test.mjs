import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { effectOperations } from "../../../packages/zelavis/dist/core/runtime/effect-boundary.js";
import { createNativeWordPressProjectRuntime } from "../dist/runtime.js";

test("WordPress startup interruption stops its acquired database and leaves the site data intact", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-wp-effect-")), entered = Deferred.makeUnsafe();
  let stops = 0;
  const process = { running: true, stop: async () => { stops++; process.running = false; } };
  const driver = createNativeWordPressProjectRuntime({ directory: root, user: userInfo().username,
    agent: { start: async () => { Effect.runSync(Deferred.succeed(entered, undefined)); return process; } },
  });
  try {
    await mkdir(join(root, "one", ".zelavis"), { recursive: true });
    await writeFile(join(root, "one", ".zelavis", "wordpress-native.json"), JSON.stringify({ databaseInitialized: true, databasePort: 65534, httpPort: 65533, mariadbd: "fake-database", socketId: "effect-test" }));
    const fiber = Effect.runFork(effectOperations(driver).start({ id: "one" }));
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(process.running, false);
    assert.equal(stops, 1);
    assert.equal((await driver.status("one")).status, "stopped");
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

test("a WordPress process stop failure remains visible and can be retried", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-wp-effect-stop-")), entered = Deferred.makeUnsafe();
  let fail = true, stops = 0;
  const process = { running: true, stop: async () => { stops++; if (fail) throw new Error("Agent refused stop"); process.running = false; } };
  const driver = createNativeWordPressProjectRuntime({ directory: root, user: userInfo().username,
    agent: { start: async () => { Effect.runSync(Deferred.succeed(entered, undefined)); return process; } },
  });
  try {
    await mkdir(join(root, "one", ".zelavis"), { recursive: true });
    await writeFile(join(root, "one", ".zelavis", "wordpress-native.json"), JSON.stringify({ databaseInitialized: true, databasePort: 65534, httpPort: 65533, mariadbd: "fake-database", socketId: "effect-stop-test" }));
    const fiber = Effect.runFork(effectOperations(driver).start({ id: "one" }));
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(process.running, true);
    await assert.rejects(driver.stop("one"), /Agent refused stop/);
    fail = false;
    await driver.stop("one");
    assert.equal(process.running, false);
    assert.equal(stops, 3);
  } finally { fail = false; await driver.close(); await rm(root, { recursive: true, force: true }); }
});

for (const unrelated of [false, true]) test(`WordPress adoption ${unrelated ? "refuses unrelated Agent execution" : "retains all three daemon handles without starting replacements"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-wp-adopt-"));
  const runtime = join(root, "one", ".zelavis");
  const site = join(runtime, "wordpress"), database = join(runtime, "mariadb");
  const config = { mariadbd: "/test/mariadbd", phpFpm: "/test/php-fpm", nginx: "/test/nginx", httpPort: 34567, socketId: "adoption-test" };
  let starts = 0;
  const children = [
    { executable: config.mariadbd, cwd: runtime, args: [`--datadir=${database}`] },
    { executable: config.phpFpm, cwd: site, args: [join(runtime, "php-fpm.conf")] },
    { executable: unrelated ? "/test/unrelated" : config.nginx, cwd: runtime, args: [join(runtime, "nginx.conf")] },
  ].map(command => {
    const process = { workloadId: "one", running: true, listen() {}, stop: async () => { process.running = false; } };
    return { process, command: { ...command, workloadId: "one" }, replay: [] };
  });
  const driver = createNativeWordPressProjectRuntime({ directory: root,
    agent: { survivesControlPlaneRestart: true, attach: async () => children, start: async () => { starts++; throw new Error("Adoption must not spawn"); } },
  });
  try {
    await mkdir(join(root, "one", ".zelavis"), { recursive: true });
    await writeFile(join(root, "one", ".zelavis", "wordpress-native.json"), JSON.stringify(config));
    if (unrelated) await assert.rejects(driver.adopt(), /unrelated process/);
    else {
      await driver.adopt();
      assert.equal((await driver.status("one")).status, "running");
      children[1].process.running = false;
      assert.equal((await driver.status("one")).status, "stopped", "nginx alone does not prove a healthy WordPress stack");
    }
    assert.equal(starts, 0);
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

test("malformed WordPress socket identities refuse cleanup and preserve Project data", async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-wp-socket-"));
  const driver = createNativeWordPressProjectRuntime({ directory: root });
  try {
    const runtime = join(root, "one", ".zelavis");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "wordpress-native.json"), JSON.stringify({ socketId: "../../unrelated" }));
    await writeFile(join(root, "one", "keep.txt"), "Project data");
    await assert.rejects(driver.destroy("one"), /socket identity is malformed/);
    assert.equal(await readFile(join(root, "one", "keep.txt"), "utf8"), "Project data");
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});
