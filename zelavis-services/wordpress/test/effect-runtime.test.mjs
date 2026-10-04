import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
