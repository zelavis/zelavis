// A Platform serves the runtime its engine composed. A service installed afterwards reaches traffic through a
// fresh engine of the same release, handed over under the persistent host's admission, with no restart.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Scope } from "effect";
import { createNodePlatformHost } from "../dist/adapters/_node-platform-host.js";
import { requestNodeRuntimeControl } from "../dist/adapters/_node-runtime-control.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const release = { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const bootstrapToken = "platform-reload-first-owner-token";
const worker = fileURLToPath(new URL("../dist/adapters/_node-runtime-worker.js", import.meta.url));
const module = fileURLToPath(new URL("../dist/adapters/_node-platform-engine.js", import.meta.url));

test("a plugin installed into a running Platform serves its route after a same-release engine reload", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-platform-reload-"));
  const scope = Scope.makeUnsafe(), logs = [];
  try {
    const host = await Effect.runPromise(createNodePlatformHost({ dataDirectory: directory, host: "127.0.0.1", initial: release,
      environment: { ZELAVIS_BOOTSTRAP_TOKEN: bootstrapToken }, startupTimeoutMs: 20_000,
      output: (stream, line) => logs.push({ stream, line }),
      resolve: (_release, configuration, environment) => Effect.succeed({ executable: process.execPath, worker, module, cwd: directory, configuration, environment }),
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const port = await Effect.runPromise(host.listen({ host: "127.0.0.1", port: 0 }));
    const url = `http://127.0.0.1:${port}`;
    const anonymous = createZelavisClient({ baseUrl: url });
    await anonymous.json("/auth/bootstrap", { method: "POST", body: { bootstrapToken, provider: "password",
      account: { email: "owner@example.com" }, credential: { identifier: "owner@example.com", password: "correct horse battery staple" } } });
    const { session } = await anonymous.auth.signInWithPassword({ identifier: "owner@example.com", password: "correct horse battery staple" });
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const probe = () => fetch(`${url}/zelavis/api/v1/plugins/reloaded/probe`, { headers });

    // Only the engine, holding the host's token, may ask for a reload.
    await assert.rejects(Effect.runPromise(requestNodeRuntimeControl(host.endpoint, { action: "reload" })), /Engine authority required/);
    await assert.rejects(Effect.runPromise(requestNodeRuntimeControl(host.endpoint, { action: "reload" }, "Bearer forged")), /Engine authority required/);

    const plugin = join(directory, "services", "reloaded");
    await mkdir(plugin, { recursive: true });
    // An installed runtime hands acquired packages its own `zelavis`; a test checkout links it.
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await symlink(fileURLToPath(new URL("..", import.meta.url)), join(directory, "node_modules", "zelavis"), "dir");
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "@test/reloaded", version: "1.0.0", type: "module",
      exports: { ".": "./index.js" }, zelavis: { kind: "plugin", namespace: "reloaded" } }));
    await writeFile(join(plugin, "index.js"), `import { zelavis } from "zelavis/sdk";
export function register() { zelavis.operations.create({ id: "probe.get", resource: "probe", action: "get", method: "GET", path: "/probe",
  spec: { operationId: "getReloadedProbe", summary: "Answer from the reloaded engine" }, handler: () => ({ status: 200, body: { reloaded: true } }) }); }\n`);
    assert.equal((await probe()).status, 404, "not mounted before it is installed");
    const generation = host.snapshot().generation;

    const installed = await fetch(`${url}/zelavis/api/v1/runtime/services`, { method: "POST", headers,
      body: JSON.stringify({ specifier: join(plugin, "index.js"), status: "installed" }) });
    const result = await installed.json();
    assert.equal(installed.status, 201, JSON.stringify(result));
    assert.equal(result.activation.status, "pending", JSON.stringify(result.activation));
    assert.match(result.activation.message, /reloading to activate/);

    // Requests made while the engine is handed over wait for it rather than fail.
    const answered = await probe();
    const body = await answered.text();
    for (let attempt = 0; attempt < 300 && host.snapshot().generation === generation; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(host.snapshot().generation > generation, `the engine was handed over: ${JSON.stringify(logs.slice(-20))}`);
    const after = answered.status === 200 ? { status: 200, body } : await probe().then(async response => ({ status: response.status, body: await response.text() }));
    assert.equal(after.status, 200, after.body);
    assert.deepEqual(JSON.parse(after.body), { reloaded: true });
    assert.deepEqual(host.snapshot().release, release, "the same release, a fresh engine");
    assert.equal(host.snapshot().requiresRecovery, false);
  } catch (error) { console.error(JSON.stringify(logs.slice(-40))); throw error; }
  finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); }
});
