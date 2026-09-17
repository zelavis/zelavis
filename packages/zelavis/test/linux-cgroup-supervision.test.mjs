/**
 * cgroup v2 host-operation supervision.
 *
 * The refusal tests run everywhere. The containment tests need Linux with a
 * delegated cgroup v2 subtree and run only when ZELAVIS_TEST_CGROUP_ROOT names
 * it, e.g. from the WSL qualification runbook:
 *
 *   systemd-run --user --scope -p Delegate=yes --unit=zelavis-cgroup-test \
 *     sh -c 'mkdir -p "$CG/agent" "$CG/operations" && echo $$ > "$CG/agent/cgroup.procs" && \
 *       ZELAVIS_TEST_CGROUP_ROOT="$CG/operations" node --test test/linux-cgroup-supervision.test.mjs'
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeHostOperationExecutor } from "../dist/adapters/_node-host-operation-executor.js";
import {
  CgroupSupervisionUnavailableError,
  createCgroupV2OperationSupervisor,
} from "../dist/adapters/_linux-cgroup-supervisor.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const CGROUP_ROOT = process.env.ZELAVIS_TEST_CGROUP_ROOT;
const linuxSkip = process.platform !== "linux"
  ? "requires Linux"
  : !CGROUP_ROOT
    ? "set ZELAVIS_TEST_CGROUP_ROOT to a delegated cgroup v2 directory"
    : false;
const signer = await createReleaseSigner();
const sha = (body) => createHash("sha256").update(body).digest("hex");
let sequence = 0;

test("cgroup supervision refuses hosts and roots it cannot prove, never falling back", async () => {
  await assert.rejects(
    createCgroupV2OperationSupervisor({ root: "/sys/fs/cgroup/zelavis", platform: "darwin" }),
    (error) => error instanceof CgroupSupervisionUnavailableError && /requires Linux/.test(error.message),
  );
  for (const root of ["/tmp/cgroup", "/sys/fs/cgroup/../etc", "relative/path"]) {
    await assert.rejects(
      createCgroupV2OperationSupervisor({ root, platform: "linux" }),
      /below \/sys\/fs\/cgroup/,
    );
  }
  await assert.rejects(
    createCgroupV2OperationSupervisor({ root: "/sys/fs/cgroup/x", platform: "linux", limits: { memoryMaxBytes: 1 } }),
    /at least 4 MiB/,
  );
  if (process.platform !== "linux") {
    const directory = await mkdtemp(join(tmpdir(), "zelavis-cgroup-refusal-"));
    try {
      await assert.rejects(
        createNodeHostOperationExecutor({
          rootDirectory: directory,
          stagingDirectory: directory,
          trust: signer.trust,
          operations: [],
          authorize: async () => true,
          supervision: { kind: "cgroup-v2", root: "/sys/fs/cgroup/zelavis/operations" },
        }),
        /requires Linux/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function executorWith(t, body, { limits, declared = { pidfile: { required: true, maxLength: 1024 } } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cgroup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "op"), body, { mode: 0o700 });
  const manifest = { id: "native.cgroup", version: "v1", sha256: sha(body), interpreter: "/bin/sh", arguments: declared };
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root,
    stagingDirectory: directory,
    trust: signer.trust,
    operations: [{ file: "op", signed: await signer.sign(manifest) }],
    authorize: async () => true,
    supervision: { kind: "cgroup-v2", root: CGROUP_ROOT, ...(limits ? { limits } : {}) },
  });
  const request = (args, deadlineMs = 10_000) => ({
    operationId: `operation_cgroup_test_${String(sequence += 1).padStart(6, "0")}`,
    operation: manifest.id, version: manifest.version, artifactDigest: manifest.sha256,
    authority: "test", arguments: args, deadline: new Date(Date.now() + deadlineMs).toISOString(),
  });
  return { executor, request, directory };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a descendant that starts a new session is still killed", { skip: linuxSkip }, async (t) => {
  const { executor, request, directory } = await executorWith(
    t,
    "setsid sh -c 'echo $$ > \"$1\"; sleep 30' _ \"$2\" < /dev/null > /dev/null 2>&1 &\nsleep 0.3\n",
  );
  const pidfile = join(directory, "escaped.pid");
  const result = await executor.execute(request({ pidfile }));
  assert.equal(result.status, "succeeded");
  const escaped = Number((await readFile(pidfile, "utf8")).trim());
  assert.equal(alive(escaped), false, `session leader ${escaped} survived cgroup supervision`);
  // The operation's cgroup is removed once it is empty.
  const leftovers = (await readdir(CGROUP_ROOT)).filter((name) => name.startsWith("zelavis-op-"));
  assert.deepEqual(leftovers, []);
});

test("the deadline kills everything in the operation cgroup", { skip: linuxSkip }, async (t) => {
  const { executor, request, directory } = await executorWith(
    t,
    "setsid sh -c 'echo $$ > \"$1\"; sleep 30' _ \"$2\" < /dev/null > /dev/null 2>&1 &\nsleep 30\n",
  );
  const pidfile = join(directory, "deadline.pid");
  const result = await executor.execute(request({ pidfile }, 800));
  assert.equal(result.timedOut, true);
  assert.equal(alive(Number((await readFile(pidfile, "utf8")).trim())), false);
});

test("leftover operation cgroups from a crashed Agent are reclaimed at startup", { skip: linuxSkip }, async () => {
  const leftover = join(CGROUP_ROOT, "zelavis-op-crashed");
  await mkdir(leftover);
  const orphan = spawn("/bin/sh", ["-c", `echo 0 > "${leftover}/cgroup.procs" && exec sleep 30`], {
    detached: true, stdio: "ignore",
  });
  orphan.unref();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(orphan.pid), true);
  const supervisor = await createCgroupV2OperationSupervisor({ root: CGROUP_ROOT });
  assert.equal(supervisor.reclaimed >= 1, true);
  assert.equal(alive(orphan.pid), false);
  assert.equal((await readdir(CGROUP_ROOT)).includes("zelavis-op-crashed"), false);
});

test("pids.max bounds a fork loop inside one operation", { skip: linuxSkip }, async (t) => {
  // Forks up to 200 sleepers, then counts the operation cgroup's members with
  // shell builtins only (a fork would fail at the ceiling).
  const { executor, request, directory } = await executorWith(
    t,
    [
      "i=0",
      // In a subshell: some shells exit when a fork fails, and the count
      // below must still run.
      "( while [ $i -lt 200 ]; do sleep 5 2>/dev/null & i=$((i+1)); done ) 2>/dev/null",
      "read -r line < /proc/self/cgroup",
      "procs=\"/sys/fs/cgroup${line#0::}/cgroup.procs\"",
      "n=0",
      "while read -r _; do n=$((n+1)); done < \"$procs\"",
      "echo \"$n\" > \"$2\"",
      "",
    ].join("\n"),
    { limits: { pidsMax: 32 } },
  );
  const out = join(directory, "members");
  await executor.execute(request({ pidfile: out }, 8_000));
  const members = Number((await readFile(out, "utf8").catch(() => "0")).trim());
  assert.ok(members >= 1 && members <= 32, `operation cgroup held ${members} processes with pids.max 32`);
});

test("a delegated zelavis agent contains an escaping operation end to end", {
  skip: linuxSkip || (!process.env.ZELAVIS_TEST_DELEGATED_AGENT && "set ZELAVIS_TEST_DELEGATED_AGENT=1 inside a delegated scope"),
}, async (t) => {
  const { runAgentCommand } = await import("../dist/cli/agent.js");
  const { createAgentProcessClient } = await import("../dist/adapters/_agent-ipc.js");
  const { hostOperationArgumentsDigest, signAgentAuthority } = await import("../dist/index.js");
  const { randomUUID } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "zelavis-delegated-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = "setsid sh -c 'echo $$ > \"$1\"; sleep 30' _ \"$2\" < /dev/null > /dev/null 2>&1 &\nsleep 0.3\n";
  const installed = join(root, "operations", "native.escape", "v1");
  await mkdir(installed, { recursive: true, mode: 0o700 });
  await writeFile(join(installed, "artifact"), body, { mode: 0o700 });
  const manifest = { id: "native.escape", version: "v1", sha256: sha(body), interpreter: "/bin/sh", arguments: { pidfile: { required: true, maxLength: 1024 } } };
  await writeFile(join(installed, "manifest.json"), JSON.stringify(await signer.sign(manifest)));
  const trust = join(root, "trust.json");
  await writeFile(trust, JSON.stringify(signer.trust), { mode: 0o644 });
  const platform = await createReleaseSigner({ keyId: "platform-qualification" });
  const platformAuthority = join(root, "platform-authority.json");
  await writeFile(platformAuthority, JSON.stringify(platform.trust), { mode: 0o644 });

  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const running = runAgentCommand({
    dataDirectory: join(root, "data"), operationsRoot: join(root, "operations"), operationTrust: trust, platformAuthority,
    operationCgroup: "delegated", operationPidsMax: 64, signal: controller.signal, onReady: ready,
  });
  t.after(async () => { controller.abort(); await running.catch(() => undefined); });
  const agent = await readyPromise;
  const client = await createAgentProcessClient({ directory: join(root, "data", "agent") });
  t.after(() => client.close());
  const pidfile = join(root, "escaped.pid");
  const base = {
    operationId: `operation_${randomUUID().replaceAll("-", "")}`, operation: manifest.id, version: manifest.version,
    artifactDigest: manifest.sha256, arguments: { pidfile }, deadline: new Date(Date.now() + 30_000).toISOString(),
  };
  const now = Date.now();
  const authority = await signAgentAuthority(platform.privateKey, {
    keyId: "platform-qualification",
    agentId: agent.operations.agentId, operationId: base.operationId, operation: base.operation, version: base.version,
    artifactDigest: base.artifactDigest, argumentsDigest: await hostOperationArgumentsDigest(base.arguments),
    actorId: "qualification", issuedAt: now, expiresAt: now + 60_000, nonce: randomUUID(),
  });
  await client.submitHostOperation({ ...base, authority });
  let summary;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    summary = await client.getHostOperation(base.operationId);
    if (summary?.status === "succeeded" || summary?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(summary.status, "succeeded");
  assert.equal(alive(Number((await readFile(pidfile, "utf8")).trim())), false);
});
