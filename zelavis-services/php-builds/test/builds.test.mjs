import assert from "node:assert/strict";
import test from "node:test";

import { BuildError, createBuilds } from "../dist/builds.js";

const principal = { id: "owner" };
const sha = (letter) => letter.repeat(64);
const FILE = "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz";
// What the upload operation's manifest accepts for its address.
const UPLOAD_URL = /^https:\/\/[a-z0-9-]+\.r2\.cloudflarestorage\.com\/[A-Za-z0-9._~\/%-]+\?[A-Za-z0-9._~%=&+\/:-]+$/;

/** A fake broker handle: each operation answers from a table, and every call is recorded. */
function harness({ answers = {}, env = {}, jobs = ["0123456789abcdef"], submitFails } = {}) {
  const calls = [];
  const records = new Map();
  let sequence = 0;
  const store = new Map();
  const operations = {
    allowed: [],
    async submit(input, who) {
      if (submitFails) throw submitFails;
      calls.push({ ...input, who });
      const operationId = `op${(sequence += 1)}`;
      const answer = typeof answers[input.operation] === "function" ? answers[input.operation](input) : answers[input.operation];
      records.set(operationId, { operationId, agent: { status: answer?.status ?? "succeeded", result: answer?.result ?? {}, resultError: answer?.resultError } });
      return { operationId };
    },
    async get(operationId) { return records.get(operationId); },
  };
  const builds = createBuilds({
    operations, environment: env, pollMs: 1, waitMs: 500, now: () => new Date("2026-10-12T10:00:00Z"), newJob: () => jobs.shift(),
    store: {
      get: async (key) => store.get(key), set: async (key, value) => { store.set(key, structuredClone(value)); },
      delete: async (key) => store.delete(key), list: async () => [...store].map(([key, value]) => ({ key, value })),
    },
  });
  return { builds, calls, store, records };
}
const R2 = { ZELAVIS_PHP_BUILDS_R2_ACCOUNT_ID: "abc12345def", ZELAVIS_PHP_BUILDS_R2_BUCKET: "zelavis-mirror", ZELAVIS_PHP_BUILDS_R2_ACCESS_KEY_ID: "key", ZELAVIS_PHP_BUILDS_R2_SECRET_ACCESS_KEY: "secret", ZELAVIS_PHP_BUILDS_PUBLIC_URL: "https://mirror.zelavis.com/" };

test("starting a build records the job before the host starts it, passes the caller's principal and the exact version", async () => {
  const { builds, calls, store } = harness({ answers: { "zelavis.php-build-start": { result: { schema: 1, platform: "linux-aarch64", cpus: 2, memoryMb: 4096 } } } });
  const record = await builds.start(principal, { php: "8.4.23" });
  assert.equal(record.state, "running");
  assert.equal(record.platform, "linux-aarch64");
  assert.deepEqual(calls.map((call) => [call.operation, call.arguments, call.who]), [["zelavis.php-build-start", { job: "0123456789abcdef", php: "8.4.23" }, principal]]);
  assert.equal(store.get("job:0123456789abcdef").php, "8.4.23");
});

test("a version that is not exact is refused before anything reaches the host", async () => {
  const { builds, calls } = harness();
  for (const php of ["8.4", "latest", "8.4.23; rm", 8, undefined]) {
    await assert.rejects(builds.start(principal, { php }), (error) => error instanceof BuildError && error.status === 400);
  }
  assert.equal(calls.length, 0);
});

test("a host that refuses leaves a failed record with the reason, and the caller's lack of permission stays a 403", async () => {
  const refused = harness({ answers: { "zelavis.php-build-start": { status: "failed", resultError: "Another build is running." } } });
  await assert.rejects(refused.builds.start(principal, { php: "8.4.23" }), /Another build is running/);
  assert.equal(refused.store.get("job:0123456789abcdef").state, "failed");
  assert.match(refused.store.get("job:0123456789abcdef").message, /Another build/);

  const forbidden = Object.assign(new Error("Not allowed."), { name: "ZelavisHostOperationForbiddenError", status: 403 });
  const denied = harness({ submitFails: forbidden });
  await assert.rejects(denied.builds.start(principal, { php: "8.4.23" }), (error) => error.status === 403);
});

test("reading a build merges what the host reports, keeping the digests of a finished one", async () => {
  const { builds, store } = harness({ answers: {
    "zelavis.php-build-start": { result: { platform: "linux-aarch64" } },
    "zelavis.php-build-status": { result: { state: "exited", exitCode: 0, log: "Done: /out", builds: [{ file: FILE, sha256: sha("a"), bytes: 24448012 }] } },
  } });
  await builds.start(principal, { php: "8.4.23" });
  const record = await builds.get(principal, "0123456789abcdef");
  assert.equal(record.state, "succeeded");
  assert.deepEqual(record.builds, [{ file: FILE, sha256: sha("a"), bytes: 24448012 }]);
  assert.equal(store.get("job:0123456789abcdef").state, "succeeded");
  assert.deepEqual((await builds.list()).map((job) => job.job), ["0123456789abcdef"]);
});

test("a build that failed or is still running is reported as such", async () => {
  for (const [reported, expected] of [[{ state: "exited", exitCode: 2, log: "boom" }, "failed"], [{ state: "running", exitCode: null, log: "..." }, "running"]]) {
    const { builds } = harness({ answers: { "zelavis.php-build-start": { result: {} }, "zelavis.php-build-status": { result: reported } } });
    await builds.start(principal, { php: "8.4.23" });
    assert.equal((await builds.get(principal, "0123456789abcdef")).state, expected);
  }
});

const finished = { "zelavis.php-build-start": { result: {} }, "zelavis.php-build-status": { result: { state: "exited", exitCode: 0, builds: [{ file: FILE, sha256: sha("a"), bytes: 1 }] } } };

test("uploading needs the mirror configured and a finished build, and signs one address per archive", async () => {
  const unconfigured = harness({ answers: finished });
  await unconfigured.builds.start(principal, { php: "8.4.23" });
  await assert.rejects(unconfigured.builds.upload(principal, "0123456789abcdef"), (error) => error.status === 409 && /not configured/.test(error.message));

  const running = harness({ env: R2, answers: { "zelavis.php-build-start": { result: {} }, "zelavis.php-build-status": { result: { state: "running" } } } });
  await running.builds.start(principal, { php: "8.4.23" });
  await assert.rejects(running.builds.upload(principal, "0123456789abcdef"), (error) => error.status === 409 && /not finished/.test(error.message));

  const ready = harness({ env: R2, answers: { ...finished, "zelavis.php-build-upload": { status: "running" } } });
  await ready.builds.start(principal, { php: "8.4.23" });
  const record = await ready.builds.upload(principal, "0123456789abcdef");
  const upload = ready.calls.find((call) => call.operation === "zelavis.php-build-upload");
  assert.deepEqual(Object.keys(upload.arguments).sort(), ["file", "job", "url"]);
  assert.match(upload.arguments.url, UPLOAD_URL);
  assert.ok(upload.arguments.url.startsWith("https://abc12345def.r2.cloudflarestorage.com/zelavis-mirror/php/8.4.23/"));
  assert.ok(!upload.arguments.url.includes("secret"), "the secret key is never in the address");
  assert.equal(record.uploads[FILE].state, "uploading");
  assert.equal(ready.builds.publicUrl(record, FILE), `https://mirror.zelavis.com/php/8.4.23/${FILE}`);

  // A second request while it is still uploading does not upload again; one after a mismatch would.
  await ready.builds.upload(principal, "0123456789abcdef");
  assert.equal(ready.calls.filter((call) => call.operation === "zelavis.php-build-upload").length, 1);
});

test("an upload counts as verified only when the host reports the digest the build produced", async () => {
  for (const [sent, expected] of [[sha("a"), "verified"], [sha("b"), "mismatch"]]) {
    const { builds, records } = harness({ env: R2, answers: { ...finished, "zelavis.php-build-upload": { result: { file: FILE, sha256: sent, bytes: 1 } } } });
    await builds.start(principal, { php: "8.4.23" });
    await builds.upload(principal, "0123456789abcdef");
    const record = await builds.get(principal, "0123456789abcdef");
    assert.equal(record.uploads[FILE].state, expected);
    assert.ok(records.size > 0);
  }
});

test("cleaning asks the host to remove the build and marks the record", async () => {
  const { builds, calls } = harness({ answers: { "zelavis.php-build-start": { result: {} }, "zelavis.php-build-clean": { result: { containerRemoved: true } } } });
  await builds.start(principal, { php: "8.4.23" });
  assert.equal((await builds.clean(principal, "0123456789abcdef")).state, "cleaned");
  assert.ok(calls.some((call) => call.operation === "zelavis.php-build-clean" && call.arguments.job === "0123456789abcdef"));
  await assert.rejects(builds.get(principal, "not-a-job"), (error) => error.status === 400);
  await assert.rejects(builds.get(principal, "ffffffffffffffff"), (error) => error.status === 404);
});

test("the host view combines the two read-only operations and says whether the mirror is configured", async () => {
  const { builds } = harness({ env: R2, answers: { "zelavis.host-report": { result: { architecture: "aarch64", cpus: 8 } }, "zelavis.container-probe": { result: { installed: true, reachable: true } } } });
  const host = await builds.host(principal);
  assert.equal(host.report.cpus, 8);
  assert.equal(host.containers.reachable, true);
  assert.deepEqual(host.mirror, { configured: true, publicBase: "https://mirror.zelavis.com" });
});
