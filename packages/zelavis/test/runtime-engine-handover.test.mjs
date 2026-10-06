import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";
import { createNodeRuntimeSupervisor } from "../dist/adapters/_node-runtime-supervisor.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { createGatewayAuthorityNonce, createGatewayAuthoritySecret, signGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../dist/platform/gateway-authority.js";
import { NODE_RUNTIME_READY_PATH } from "../dist/adapters/_node-runtime-protocol.js";
import { createNodeRuntimeGateway } from "../dist/adapters/_node-runtime-gateway.js";
import { freezeNodeProjectRelease, verifyNodeProjectRelease } from "../dist/adapters/_node-project-release.js";

const worker = fileURLToPath(new URL("../dist/adapters/_node-runtime-worker.js", import.meta.url));
const token = "runtime-handover-first-owner-test-token";
const old = { version: "first", digest: "test:first" }, next = { version: "second", digest: "test:second" };
const recipeManifest = JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8"));

for (const role of ["platform", "project"]) test(`the actual ${role} Zelavis composition transfers live ownership behind the same ingress`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), `zelavis-engine-${role}-`)), agent = createLocalAgentProcessRunner();
  const logs = [];
  const gatewaySecret = createGatewayAuthoritySecret();
  let supervisor, recipeDriver;
  try {
    let configuration = { dataDirectory: root, host: "127.0.0.1" };
    if (role === "project") {
      const recipe = { name: recipeManifest.name, version: recipeManifest.version, specifier: recipeManifest.name, runtimeKinds: ["native"] };
      recipeDriver = createNodeProcessProjectRuntime({ directory: root });
      await recipeDriver.prepare({ id: "one", name: "One", kind: "zelavis", runtimeKind: "native", recipe }, recipe);
      configuration = { projectId: "one", dataDirectory: join(root, "one", ".zelavis"), descriptor: join(root, "one", "project.json") };
    }
    supervisor = await Effect.runPromise(createNodeRuntimeSupervisor({ agent, workloadId: role, initial: old, generation: 1,
      resolve: () => Effect.succeed({ executable: process.execPath, worker,
        module: fileURLToPath(new URL(`../dist/adapters/_node-${role}-engine.js`, import.meta.url)), cwd: root,
        environment: role === "platform" ? { ZELAVIS_BOOTSTRAP_TOKEN: token } : { ZELAVIS_PROJECT_GATEWAY_SECRET: gatewaySecret }, configuration }),
      checkpoint: () => Effect.void, commit: () => Effect.void,
      output: (stream, line) => logs.push({ stream, line }),
    }));
    const port = await Effect.runPromise(supervisor.listen({ host: "127.0.0.1", port: 0 }));
    const url = `http://127.0.0.1:${port}`;
    const initial = await fetch(url, { redirect: "manual" });
    const body = await initial.text();
    assert.ok(initial.status < 500 || role === "project" && initial.status === 503, JSON.stringify(logs));
    let owner;
    if (role === "platform") {
      const anonymous = createZelavisClient({ baseUrl: url });
      const bootstrap = await anonymous.json("/auth/bootstrap", { method: "POST", body: {
        bootstrapToken: token, provider: "password", account: { email: "owner@example.com" },
        credential: { identifier: "owner@example.com", password: "correct horse battery staple" },
      } });
      const signedIn = await anonymous.auth.signInWithPassword({ identifier: "owner@example.com", password: "correct horse battery staple" });
      assert.equal(bootstrap.account.id, signedIn.account.id);
      owner = createZelavisClient({ baseUrl: url, headers: { authorization: `Bearer ${signedIn.session.token}` } });
    }
    const headers = async (projectId = "one") => ({ [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await signGatewayAuthority(gatewaySecret, {
      projectId, subject: "project-user", subjectType: "user", tenantId: "tenant", permissions: [], scopeId: "platform", generation: 1,
      runtimeNodeId: "local", nonce: createGatewayAuthorityNonce(), expiresAt: Date.now() + 30_000,
    }) });
    const traffic = Array.from({ length: 20 }, async () => {
      const response = await fetch(`${url}/zelavis/api/v1/${role === "platform" ? "auth/bootstrap" : "runtime/access"}`, { headers: role === "project" ? await headers() : {} });
      assert.equal(response.status, 200); await response.text();
    });
    await Promise.all([Effect.runPromise(supervisor.replace(next)), ...traffic]);
    assert.equal(supervisor.server.address().port, port);
    const after = await fetch(url, { redirect: "manual" });
    assert.ok(after.status < 500 || role === "project" && after.status === 503, JSON.stringify(logs));
    assert.equal((await fetch(`${url}${NODE_RUNTIME_READY_PATH}`)).status, 404);
    if (role === "project") {
      assert.equal(await after.text(), body);
      const access = await (await fetch(`${url}/zelavis/api/v1/runtime/access`, { headers: await headers() })).json();
      assert.notEqual(access.mode, "owner");
      assert.equal((await fetch(`${url}/zelavis/api/v1/runtime/access`, { headers: await headers("another") })).status, 401);
    }
    else {
      await after.text();
      assert.equal((await owner.json("/runtime/access")).mode, "owner");
      assert.equal((await createZelavisClient({ baseUrl: url }).json("/auth/bootstrap")).required, false);
    }
  } finally {
    await Effect.runPromise(supervisor?.close ?? Effect.void);
    await recipeDriver?.close(); await agent.close(); await rm(root, { recursive: true, force: true });
  }
});

test("an App handover uses immutable snapshots and a stable Gateway replay boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-app-gateway-handover-")), agent = createLocalAgentProcessRunner();
  const driver = createNodeProcessProjectRuntime({ directory: root });
  let supervisor;
  try {
    const recipe = { name: recipeManifest.name, version: recipeManifest.version, specifier: recipeManifest.name, runtimeKinds: ["native"] };
    await driver.prepare({ id: "one", name: "One", kind: "zelavis", runtimeKind: "native", recipe }, recipe);
    const directory = join(root, "one"), dataDirectory = join(directory, ".zelavis");
    const first = await Effect.runPromise(freezeNodeProjectRelease(directory));
    const staged = join(root, "candidate");
    await cp(directory, staged, { recursive: true });
    const record = JSON.parse(await readFile(join(staged, "project.json"), "utf8"));
    record.name = "New descriptor";
    await writeFile(join(staged, "project.json"), JSON.stringify(record));
    const second = await Effect.runPromise(freezeNodeProjectRelease(directory, staged));
    const parentSecret = createGatewayAuthoritySecret();
    let activeWorkerSecret = createGatewayAuthoritySecret();
    const secrets = new Map([[first.digest, activeWorkerSecret]]);
    const gateway = createNodeRuntimeGateway({ projectId: "one", parentSecret: () => parentSecret, workerSecret: () => activeWorkerSecret });
    supervisor = await Effect.runPromise(createNodeRuntimeSupervisor({ agent, workloadId: "one", initial: first, generation: 1,
      headers: gateway,
      resolve: selected => Effect.gen(function* () {
        const { snapshot } = yield* verifyNodeProjectRelease(directory, "one", selected);
        if (!secrets.has(selected.digest)) secrets.set(selected.digest, createGatewayAuthoritySecret());
        return { executable: process.execPath, worker, module: fileURLToPath(new URL("../dist/adapters/_node-project-engine.js", import.meta.url)), cwd: root,
          environment: { ZELAVIS_PROJECT_GATEWAY_SECRET: secrets.get(selected.digest) },
          configuration: { projectId: "one", dataDirectory, descriptor: join(snapshot, "project.json"), recipeDataDirectory: snapshot } };
      }),
      checkpoint: () => Effect.void,
      commit: selected => Effect.sync(() => { activeWorkerSecret = secrets.get(selected.digest); }),
    }));
    const port = await Effect.runPromise(supervisor.listen({ host: "127.0.0.1", port: 0 }));
    const path = `http://127.0.0.1:${port}/zelavis/api/v1/runtime/access`;
    const signed = () => signGatewayAuthority(parentSecret, { projectId: "one", subject: "member", subjectType: "user", tenantId: "tenant", permissions: [], scopeId: "platform", generation: 5,
      runtimeNodeId: "local", nonce: createGatewayAuthorityNonce(), expiresAt: Date.now() + 30_000 });
    const captured = await signed();
    const initial = await fetch(path, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: captured } });
    assert.equal(initial.status, 200); await initial.text();
    await Effect.runPromise(supervisor.admission.pause);
    const queued = fetch(path, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await signed() } });
    for (let attempt = 0; supervisor.admission.snapshot().waiting !== 1 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(supervisor.admission.snapshot().waiting, 1);
    await Effect.runPromise(supervisor.replace(second));
    const authorized = await queued;
    assert.equal(authorized.status, 200); await authorized.text();
    const replay = await fetch(path, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: captured } });
    assert.equal(replay.status, 401); await replay.text();
    assert.equal(supervisor.server.address().port, port);
    const bypass = await fetch(`${supervisor.snapshot().owner.url}/zelavis/api/v1/runtime/access`, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await signed() } });
    assert.equal(bypass.status, 401); await bypass.text();
  } finally {
    await Effect.runPromise(supervisor?.close ?? Effect.void);
    await driver.close(); await agent.close(); await rm(root, { recursive: true, force: true });
  }
});
