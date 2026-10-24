// The runtime, environment, edge-onboarding and service-registry operations through the route, the SDK and the CLI. Where a bare
// Platform answers, the three are compared answer for answer; for every operation, the SDK and the CLI are required to ask the
// route for exactly the same thing.
import assert from "node:assert/strict";
import test from "node:test";
import { runRuntimeCommand } from "../dist/cli/runtime.js";
import { runEnvironmentCommand } from "../dist/cli/environment.js";
import { runEdgeCommand } from "../dist/cli/edge.js";
import { runCli } from "../dist/cli/commands.js";

// `zelavis services …` and `zelavis extensions …` are routed by the main command, which reports a failure rather than throwing it.
const main = async (args) => {
  const realError = console.error, lines = [];
  console.error = (...parts) => lines.push(parts.join(" "));
  process.exitCode = undefined;
  try { await runCli(args); } finally { console.error = realError; }
  const failed = process.exitCode !== undefined && process.exitCode !== 0;
  process.exitCode = undefined;
  if (failed) throw new Error(lines.join("\n") || "The command failed.");
};
const runServicesCommand = (args) => main(["services", ...args]);
const runExtensionsCommand = (args) => main(["extensions", ...args]);
import { outcome, platform, viaCli, viaSdk } from "./_runtime.mjs";

const compare = async (t, scenarios) => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t);
    results[surface] = [];
    for (const step of scenarios(p)[surface]) results[surface].push(await outcome(step));
  }
  return results;
};

test("the runtime's configuration, access, settings and the service registry's extensions answer the same through HTTP, the SDK and the CLI", async (t) => {
  const results = await compare(t, (p) => ({
    http: [() => p.send("GET", "/runtime/config"), () => p.send("GET", "/runtime/access"), () => p.send("GET", "/runtime/settings"), () => p.send("GET", "/runtime/extensions"), () => p.send("POST", "/runtime/services", { specifier: "" }), () => p.send("PATCH", "/runtime/services/nope", { status: "installed" })],
    sdk: [() => p.client.runtime.config(), () => p.client.runtime.access(), () => p.client.runtime.settings(), () => p.client.services.extensions(), () => p.client.services.register({ specifier: "" }), () => p.client.services.update("nope", { status: "installed" })],
    cli: [() => p.cli(runRuntimeCommand, ["config"]), () => p.cli(runRuntimeCommand, ["access"]), () => p.cli(runRuntimeCommand, ["settings"]), () => p.cli(runExtensionsCommand, []), () => p.cli(runServicesCommand, ["register", "--specifier", ""]), () => p.cli(runServicesCommand, ["install", "nope"])],
  }));
  assert.ok(results.http.slice(0, 4).every((entry) => entry.answer !== undefined), "config, access, settings and extensions are answered");
  for (const at of [0, 1, 2]) {
    assert.deepEqual(results.sdk[at], results.http[at], `SDK step ${at}`);
    assert.deepEqual(results.cli[at], results.http[at], `CLI step ${at}`);
  }
  assert.ok(results.http[4].refused && results.sdk[4].refused && results.cli[4].refused, "an empty specifier is refused everywhere");
});

test("every runtime, environment, edge and service operation asks the route for exactly the same through the SDK and the CLI", async () => {
  const cases = [
    [["GET", "/runtime/config"], (c) => c.runtime.config(), runRuntimeCommand, ["config"]],
    [["GET", "/runtime/access"], (c) => c.runtime.access(), runRuntimeCommand, ["access"]],
    [["GET", "/runtime/settings"], (c) => c.runtime.settings(), runRuntimeCommand, ["settings"]],
    [["PATCH", "/runtime/settings", { theme: "dark" }], (c) => c.runtime.updateSettings({ theme: "dark" }), runRuntimeCommand, ["update-settings", "--data", '{"theme":"dark"}']],
    [["GET", "/runtime/environment"], (c) => c.environment.identity(), runEnvironmentCommand, ["identity"]],
    [["GET", "/runtime/environment/health"], (c) => c.environment.health(), runEnvironmentCommand, ["health"]],
    [["POST", "/runtime/environment/sessions", { label: "x" }], (c) => c.environment.createSession({ label: "x" }), runEnvironmentCommand, ["create-session", "--data", '{"label":"x"}']],
    [["PATCH", "/runtime/environment/sessions/s1", { label: "y", expectedVersion: 0 }], (c) => c.environment.updateSession("s1", { label: "y", expectedVersion: 0 }), runEnvironmentCommand, ["update-session", "s1", "--data", '{"label":"y","expectedVersion":0}']],
    [["GET", "/runtime/environment/sessions/s1"], (c) => c.environment.getSession("s1"), runEnvironmentCommand, ["session", "s1"]],
    [["DELETE", "/runtime/environment/sessions/s1"], (c) => c.environment.closeSession("s1"), runEnvironmentCommand, ["close-session", "s1"]],
    [["POST", "/runtime/environment/sessions/s1/usage", { cpuMs: 5 }], (c) => c.environment.recordUsage("s1", { cpuMs: 5 }), runEnvironmentCommand, ["usage", "s1", "--data", '{"cpuMs":5}']],
    [["POST", "/runtime/environment/sessions/s1/processes", { command: "ls" }], (c) => c.environment.startProcess("s1", { command: "ls" }), runEnvironmentCommand, ["start-process", "s1", "--data", '{"command":"ls"}']],
    [["GET", "/runtime/environment/processes/p1"], (c) => c.environment.getProcess("p1"), runEnvironmentCommand, ["process", "p1"]],
    [["POST", "/runtime/environment/processes/p1/operations", { operation: "stop" }], (c) => c.environment.operateProcess("p1", { operation: "stop" }), runEnvironmentCommand, ["operate-process", "p1", "--data", '{"operation":"stop"}']],
    [["GET", "/runtime/environment/sessions/s1/events?after=c1&limit=5"], (c) => c.environment.readEvents("s1", { after: "c1", limit: 5 }), runEnvironmentCommand, ["events", "s1", "--after", "c1", "--limit", "5"]],
    [["GET", "/runtime/edge/onboard/preflight?hostname=app.example.com"], (c) => c.edge.preflightHostname("app.example.com"), runEdgeCommand, ["preflight", "app.example.com"]],
    [["POST", "/runtime/edge/onboard", { mode: "hostname", hostname: "app.example.com" }], (c) => c.edge.onboardHostname({ mode: "hostname", hostname: "app.example.com" }), runEdgeCommand, ["onboard", "--mode", "hostname", "--hostname", "app.example.com"]],
    [["GET", "/runtime/edge/certificates"], (c) => c.edge.certificates(), runEdgeCommand, ["certificates"]],
    [["POST", "/runtime/edge/certificates/renew", { hostname: "app.example.com", renewIfWithinDays: 10 }], (c) => c.edge.renewCertificates({ hostname: "app.example.com", renewIfWithinDays: 10 }), runEdgeCommand, ["renew", "--hostname", "app.example.com", "--renew-if-within-days", "10"]],
    [["POST", "/runtime/services", { specifier: "@acme/x", name: "x", status: "installed" }], (c) => c.services.register({ specifier: "@acme/x", name: "x", status: "installed" }), runServicesCommand, ["register", "--specifier", "@acme/x", "--name", "x", "--install"]],
    [["PATCH", "/runtime/services/x", { status: "installed" }], (c) => c.services.update("x", { status: "installed" }), runServicesCommand, ["install", "x"]],
    [["GET", "/runtime/extensions?owner=y"], (c) => c.services.extensions("y"), runExtensionsCommand, ["--for", "y"]],
  ];
  for (const [[method, path, body], sdk, command, args] of cases) {
    const expected = [{ method, path, ...(body === undefined ? {} : { body }) }];
    const clean = (list) => list.map((entry) => ({ method: entry.method, path: entry.path, ...(entry.body === undefined ? {} : { body: entry.body }) }));
    assert.deepEqual(clean(await viaSdk(sdk)), expected, `SDK ${method} ${path}`);
    const viaTheCli = clean(await viaCli(command, args));
    // The existing services commands read the registry first; only the request the operation names matters.
    assert.deepEqual(viaTheCli.filter((entry) => entry.method === method && entry.path === path), expected, `CLI ${method} ${path}`);
  }
});
