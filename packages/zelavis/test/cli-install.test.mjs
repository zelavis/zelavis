import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../dist/cli/index.js";

async function capture(args, runtime) {
  const output = [], errors = [];
  const log = console.log, error = console.error, previousExitCode = process.exitCode;
  console.log = (value) => output.push(String(value));
  console.error = (value) => errors.push(String(value));
  process.exitCode = undefined;
  try { await runCli(args, { runtime }); return { output, errors, code: process.exitCode ?? 0 }; }
  finally { console.log = log; console.error = error; process.exitCode = previousExitCode; }
}

test("install delegates the complete argument list to the local runtime", async () => {
  const calls = [];
  const args = ["--from-release", "/stage", "--dry-run", "--json", "--public"];
  const result = await capture(["install", ...args], { async serve() { throw new Error("unexpected serve"); }, async install(input) { calls.push(input); } });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [args]);
});

test("install without a host adapter refuses and help states the local boundary", async () => {
  const missing = await capture(["install", "--from-release", "/stage"], { async serve() {} });
  assert.equal(missing.code, 1);
  assert.match(missing.errors.join("\n"), /local host adapter/);
  const help = await capture(["install", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.output.join("\n"), /Host-local only; no HTTP endpoint/);
});
