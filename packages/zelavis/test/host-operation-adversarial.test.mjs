import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeHostOperationExecutor } from "../dist/adapters/_node-host-operation-executor.js";
import { createAgentOperationManager, createMemorySystemStore } from "../dist/index.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const signer = await createReleaseSigner();

const sha = (body) => createHash("sha256").update(body).digest("hex");
let sequence = 0;

async function fixture(t, body, { nested = false, declared = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-host-adversarial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  const staging = join(directory, "staging");
  await mkdir(root, { mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const relative = nested ? "bin/operation.sh" : "operation.sh";
  if (nested) await mkdir(join(root, "bin"), { mode: 0o700 });
  const file = join(root, relative);
  await writeFile(file, body, { mode: 0o700 });
  await chmod(file, 0o700);
  const manifest = { id: "native.adversarial", version: "v1", sha256: sha(body), interpreter: "/bin/sh", arguments: declared };
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root,
    stagingDirectory: staging,
    trust: signer.trust,
    operations: [{ file: relative, signed: await signer.sign(manifest) }],
    authorize: async () => true,
  });
  const request = (overrides = {}) => ({
    operationId: `operation_adversarial_${String(sequence += 1).padStart(6, "0")}`,
    operation: manifest.id,
    version: manifest.version,
    artifactDigest: manifest.sha256,
    authority: "test",
    arguments: {},
    deadline: new Date(Date.now() + 10_000).toISOString(),
    ...overrides,
  });
  return { directory, root, staging, file, executor, request, manifest };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("a replaced artifact with identical bytes is refused, and so is a replaced parent", async (t) => {
  const body = "#!/bin/sh\nprintf ok\n";
  const replaced = await fixture(t, body);
  assert.equal((await replaced.executor.execute(replaced.request())).status, "succeeded");
  // Same digest, new inode: a digest check alone would accept this file.
  await writeFile(`${replaced.file}.new`, body, { mode: 0o700 });
  await rename(`${replaced.file}.new`, replaced.file);
  await assert.rejects(replaced.executor.execute(replaced.request()), /changed after registration/);

  const parent = await fixture(t, body, { nested: true });
  assert.equal((await parent.executor.execute(parent.request())).status, "succeeded");
  const bin = join(parent.root, "bin");
  await rename(bin, join(parent.root, "bin-old"));
  await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, "operation.sh"), body, { mode: 0o700 });
  await assert.rejects(parent.executor.execute(parent.request()), /parent changed after registration/);

  const loosened = await fixture(t, body);
  await chmod(loosened.root, 0o777);
  await assert.rejects(loosened.executor.execute(loosened.request()), /parent changed after registration/);
  await chmod(loosened.root, 0o700);
});

test("execution runs a private verified copy, not the registered path", async (t) => {
  const { executor, request, file, staging } = await fixture(
    t,
    "#!/bin/sh\nprintf '%s' \"$0\"\n",
  );
  const result = await executor.execute(request());
  assert.equal(result.status, "succeeded");
  assert.notEqual(result.stdout, file);
  assert.ok(result.stdout.startsWith(await realpath(staging)), result.stdout);
  // The copy is removed once the operation finishes.
  const [privateDirectory] = await readdir(staging);
  assert.deepEqual(await readdir(join(staging, privateDirectory)), []);

  await assert.rejects(
    createNodeHostOperationExecutor({
      rootDirectory: join(file, ".."),
      stagingDirectory: await (async () => {
        const open = join(staging, "..", "open-staging");
        await mkdir(open, { mode: 0o777 });
        await chmod(open, 0o777);
        return open;
      })(),
      operations: [],
      trust: signer.trust,
      authorize: async () => true,
    }),
    /staging directory must not be group- or world-writable/,
  );
});

const PIDFILE = { pidfile: { required: true, maxLength: 1024 } };

test("the deadline kills the operation's whole process group", async (t) => {
  // $1 is --pidfile, $2 its value. The background sleep is a grandchild that
  // a kill of the immediate child alone would leave running.
  const { executor, request, directory } = await fixture(
    t,
    "#!/bin/sh\nsleep 30 &\necho $! > \"$2\"\nsleep 30\n",
    { declared: PIDFILE },
  );
  const pidfile = join(directory, "grandchild.pid");
  const started = Date.now();
  const result = await executor.execute(request({
    arguments: { pidfile },
    deadline: new Date(Date.now() + 750).toISOString(),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000, "the deadline, not the grandchild, ended the operation");
  const grandchild = Number((await readFile(pidfile, "utf8")).trim());
  assert.ok(grandchild > 0);
  assert.equal(await waitFor(() => !alive(grandchild)), true, `grandchild ${grandchild} survived the deadline`);
});

test("an operation's leftover descendants are killed when it exits", async (t) => {
  const { executor, request, directory } = await fixture(
    t,
    "#!/bin/sh\nsleep 30 &\necho $! > \"$2\"\nexit 0\n",
    { declared: PIDFILE },
  );
  const pidfile = join(directory, "leftover.pid");
  const started = Date.now();
  const result = await executor.execute(request({ arguments: { pidfile } }));
  assert.equal(result.status, "succeeded");
  assert.equal(result.timedOut, undefined);
  // The leftover holds the output pipe; without the group kill the operation
  // would not finish until it did.
  assert.ok(Date.now() - started < 5_000);
  const leftover = Number((await readFile(pidfile, "utf8")).trim());
  assert.equal(await waitFor(() => !alive(leftover)), true, `leftover ${leftover} outlived its operation`);
});

test("a group kill refused after the leader's pid was recycled does not fail the operation", async (t) => {
  // The group is killed again when the leader exits, at which point the leader
  // has been reaped and its pid is free. A pid the kernel has already recycled
  // into a group this process may not signal answers EPERM rather than ESRCH,
  // which is the same benign race: the operation's descendants are gone either
  // way. Throwing would escape the exit handler and crash the host instead.
  const { executor, request } = await fixture(t, "#!/bin/sh\necho done\n");
  const kill = process.kill.bind(process);
  t.after(() => { process.kill = kill; });
  let refused = 0;
  process.kill = (pid, signal) => {
    if (pid >= 0) return kill(pid, signal);
    refused += 1;
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
  };
  const result = await executor.execute(request());
  assert.ok(refused > 0, "the executor never signalled the operation's process group");
  assert.equal(result.status, "succeeded");
});

test("an operation recovered after an Agent crash is not executed a second time", async (t) => {
  const { executor, request, directory } = await fixture(
    t,
    "#!/bin/sh\necho run >> \"$2\"\n",
    { declared: PIDFILE },
  );
  const marker = join(directory, "runs.log");
  const store = createMemorySystemStore();
  // The first Agent claims the operation and dies without finishing it.
  const crashed = await createAgentOperationManager({
    store,
    executor: { execute: () => new Promise(() => {}) },
  });
  const input = request({
    arguments: { pidfile: marker },
    deadline: new Date(Date.now() + 200).toISOString(),
  });
  await crashed.submit(input);
  const running = await waitFor(async () =>
    (await store.get("agent-operations", input.operationId))?.value.status === "running");
  assert.equal(running, true);

  // Its lease lapses (deadline + 60 s in production; forced here).
  await new Promise((resolve) => setTimeout(resolve, 250));
  const record = await store.get("agent-operations", input.operationId);
  assert.ok(await store.compareAndSet("agent-operations", input.operationId, record.updatedAt, {
    ...record.value,
    lease: { ...record.value.lease, expiresAt: new Date(Date.now() - 1).toISOString() },
  }));

  // The replacement Agent recovers it with the real executor, which refuses
  // the expired deadline instead of running the side effect again.
  const replacement = await createAgentOperationManager({ store, executor });
  await replacement.reconcile();
  const recovered = await replacement.get(input.operationId);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.attempts, 2);
  assert.ok(recovered.events.some((event) => event.type === "recovered"));
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  await replacement.close();
});

const hasPerl = (() => {
  try {
    return (spawnSync("perl", ["-e", "exit 0"]).status === 0);
  } catch {
    return false;
  }
})();

test("a descendant that escapes the group cannot hold the operation open", { skip: !hasPerl && "perl is not installed" }, async (t) => {
  // It starts a new session (leaving the process group) and keeps stdout open.
  // The group kill cannot reach it — a documented limit that needs cgroups —
  // but the operation must still finish shortly after its leader exits.
  const { executor, request, directory } = await fixture(
    t,
    "#!/bin/sh\nperl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); open(my $f, \">\", $ARGV[0]); print $f $$; close $f; sleep 30; exit 0 }' \"$2\"\n",
    { declared: PIDFILE },
  );
  const pidfile = join(directory, "escaped.pid");
  const started = Date.now();
  const result = await executor.execute(request({ arguments: { pidfile } }));
  const elapsed = Date.now() - started;
  const escaped = Number((await readFile(pidfile, "utf8")).trim());
  t.after(() => { try { process.kill(escaped, "SIGKILL"); } catch {} });
  assert.equal(result.status, "succeeded");
  assert.ok(elapsed < 3_000, `operation took ${elapsed} ms while an escaped descendant held its pipes`);
});
