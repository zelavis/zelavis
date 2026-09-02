import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCENARIO = fileURLToPath(
  new URL("./fixtures/server-frontend-scenario.mjs", import.meta.url),
);

/**
 * Runs the scenario in its own process.
 *
 * The frontend driver spawns a child whose piped stdio keeps `node --test`
 * alive after the assertions finish — the first version of this passed and then
 * hung the suite forever. Isolated, the child tree dies with the scenario, and
 * a hang becomes a timeout this reports rather than a run that never returns.
 */
async function runScenario() {
  const { stdout } = await run(process.execPath, [SCENARIO], {
    timeout: 90_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });

  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("ZELAVIS_RESULT "));
  assert.ok(line, `scenario printed no result:\n${stdout}`);

  return JSON.parse(line.slice("ZELAVIS_RESULT ".length));
}

test("a server frontend is spawned, answers, and stops", async () => {
  const result = await runScenario();

  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.steps, ["prepared"]);

  // A frontend knows nothing about Zelavis beyond the port it is handed, so
  // readiness is the port accepting connections rather than a handshake.
  assert.equal(result.startStatus, "running");
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // "running" has to mean the process is answering: the Gateway routes a
  // Project's public traffic to this URL.
  assert.equal(result.httpStatus, 200);
  assert.match(result.body, /served by the frontend on \d+/);

  // The port it served on is the one the Platform allocated, not one the
  // frontend chose for itself.
  const port = new URL(result.url).port;
  assert.match(result.body, new RegExp(`on ${port}$`));
});

test("stopping a server frontend actually stops it", async () => {
  const result = await runScenario();

  // Routed by Project id, which the local runtime resolves by reading the
  // Project record back from disk — a frontend that never wrote one could be
  // started and never stopped.
  assert.equal(result.stopStatus, "stopped");
  assert.equal(result.statusAfterStop, "stopped");

  // And the process is gone rather than merely reported as stopped.
  assert.equal(result.reachableAfterStop, false);
});
