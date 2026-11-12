import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../dist/cli/index.js";

async function serveOptions(args, env = {}) {
  const saved = process.env.ZELAVIS_SERVICES_DIR;
  if (env.ZELAVIS_SERVICES_DIR === undefined) delete process.env.ZELAVIS_SERVICES_DIR;
  else process.env.ZELAVIS_SERVICES_DIR = env.ZELAVIS_SERVICES_DIR;
  let seen;
  try {
    await runCli(["serve", ...args], { runtime: { serve: async (options) => { seen = options; } } });
  } finally {
    if (saved === undefined) delete process.env.ZELAVIS_SERVICES_DIR;
    else process.env.ZELAVIS_SERVICES_DIR = saved;
  }
  return seen;
}

test("serve takes the folder services are loaded and installed from", async () => {
  assert.equal((await serveOptions(["--services-dir", "./services"])).servicesDirectory, "./services");
  assert.equal((await serveOptions(["--services-dir=./mine"])).servicesDirectory, "./mine");
});

test("the flag wins over ZELAVIS_SERVICES_DIR, and without either nothing is set", async () => {
  assert.equal((await serveOptions(["--services-dir", "./flag"], { ZELAVIS_SERVICES_DIR: "./env" })).servicesDirectory, "./flag");
  assert.equal((await serveOptions([], { ZELAVIS_SERVICES_DIR: "./env" })).servicesDirectory, "./env");
  assert.equal("servicesDirectory" in (await serveOptions([])), false, "the default stays <data>/services");
});

test("--enrollment-port and --enrollment-address reach the Platform host, and an address without a port is refused", async () => {
  const options = await serveOptions(["--enrollment-port", "8444", "--enrollment-address", "203.0.113.5", "--enrollment-address=panel.example.com"]);
  assert.deepEqual(options.enrollment, { port: 8444, addresses: ["203.0.113.5", "panel.example.com"] });
  assert.equal((await serveOptions([])).enrollment, undefined);
  const realError = console.error; const savedExit = process.exitCode; const messages = [];
  console.error = (...parts) => messages.push(parts.join(" "));
  try {
    assert.equal(await serveOptions(["--enrollment-address", "203.0.113.5"]), undefined, "serve is never reached");
  } finally { console.error = realError; process.exitCode = savedExit; }
  assert.match(messages.join("\n"), /requires --enrollment-port/);
});
