import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import {
  cleanupDue, cleanupIntervalMs, GitHubMaintenanceError, maintainStorage,
  githubAPI, maintenanceLoop, repository, startDevelopmentMaintenance, timestampVariable,
} from "../github-storage-maintenance.mjs";

const now = Date.parse("2026-10-06T12:00:00.000Z");
const old = "2026-09-01T00:00:00.000Z";
const cache = { id: 12, key: `node-cache-Linux-x64-pnpm-${"a".repeat(64)}`, last_accessed_at: old };
const archive = { id: 23, name: "zelavis-linux-arm64", created_at: old, workflow_run: { id: 34 } };
function fixture({ timestamp, caches = [], artifacts = [], push = true, fail, raceCreation = false, concurrentCompletion = false, retained = false } = {}) {
  const calls = [];
  let variableReads = 0;
  const api = (method, path, options = {}) => Effect.try({
    try: () => {
      calls.push({ method, path, options });
      if (fail) fail(method, path);
      if (path === `repos/${repository}`) return { full_name: repository, permissions: { push } };
      if (path.includes("variables?")) {
        variableReads++;
        if (concurrentCompletion && variableReads === 2) timestamp = new Date(now).toISOString();
        return [{ variables: timestamp === undefined ? [] : [{ name: timestampVariable, value: timestamp }] }];
      }
      if (path.includes("artifacts?")) return [{ artifacts: [] }, { artifacts: artifacts.slice() }];
      if (path.includes("caches?")) return [{ actions_caches: [] }, { actions_caches: caches.slice() }];
      if (path.endsWith("/actions/runs/34")) return { path: ".github/workflows/distribution.yml", status: "completed", repository: { full_name: repository } };
      if (method === "DELETE") {
        const id = Number(path.split("/").at(-1));
        if (!retained) { caches = caches.filter((item) => item.id !== id); artifacts = artifacts.filter((item) => item.id !== id); }
        return null;
      }
      if (["POST", "PATCH"].includes(method) && path.includes("variables")) {
        if (raceCreation && method === "POST") throw new GitHubMaintenanceError("Created concurrently", 422);
        timestamp = options.fields.value;
        return null;
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }, catch: (error) => error,
  });
  return { api, calls, timestamp: () => timestamp };
}
const run = (f, mode = "clean") => Effect.runPromise(maintainStorage({ api: f.api, now: () => now, mode }));

test("shared timestamp is due only after seven days; invalid/future values fail closed", () => {
  assert.equal(cleanupDue(undefined, now), true);
  assert.equal(cleanupDue(new Date(now - cleanupIntervalMs + 1).toISOString(), now), false);
  assert.equal(cleanupDue(new Date(now - cleanupIntervalMs).toISOString(), now), true);
  assert.throws(() => cleanupDue("not a timestamp", now), /Invalid/);
  assert.throws(() => cleanupDue(new Date(now + 1).toISOString(), now), /Invalid/);
});

test("contributors without Write access cannot modify shared storage", async () => {
  const f = fixture({ push: false });
  assert.equal((await run(f)).status, "skipped");
  assert.equal(f.calls.length, 1);
});

test("recent shared timestamp skips even storage listing and does not write", async () => {
  const f = fixture({ timestamp: new Date(now).toISOString() });
  assert.equal((await run(f)).status, "not-due");
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

test("check mode is read-only, handles pagination and preserves security/unknown/recent items", async () => {
  const f = fixture({ caches: [cache, { ...cache, id: 13, key: "unknown" }, { ...cache, id: 14, last_accessed_at: new Date(now).toISOString() }], artifacts: [archive, { ...archive, id: 24, name: "sarif-artifact-actions" }, { ...archive, id: 25, name: "unknown" }] });
  const result = await run(f, "check");
  assert.equal(result.status, "checked");
  assert.equal(result.deletions.length, 2);
  assert.equal(result.preserved.length, 4);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

test("cleanup verifies deletion then creates and verifies the shared timestamp", async () => {
  const f = fixture({ caches: [cache], artifacts: [archive] });
  const result = await run(f);
  assert.equal(result.deleted, 2);
  assert.equal(f.timestamp(), new Date(now).toISOString());
  const write = f.calls.findIndex(({ method }) => method === "POST");
  assert.ok(f.calls.slice(0, write).some(({ path }) => path.includes("artifacts?")));
  assert.ok(f.calls.slice(write + 1).some(({ path }) => path.includes("variables?")));
});

test("failed deletions and unsuccessful verification leave the timestamp unchanged", async () => {
  const f = fixture({ timestamp: old, caches: [cache], fail: (method) => { if (method === "DELETE") throw new GitHubMaintenanceError("Forbidden", 403); } });
  await assert.rejects(run(f), /Forbidden/);
  assert.equal(f.timestamp(), old);
  assert.ok(f.calls.every(({ method }) => !["POST", "PATCH"].includes(method)));
  const retained = fixture({ caches: [cache], retained: true });
  await assert.rejects(run(retained), /still found/);
  assert.equal(retained.timestamp(), undefined);
});

test("missing variable permissions fail before deletion", async () => {
  const f = fixture({ caches: [cache], fail: (_, path) => { if (path.includes("variables")) throw new GitHubMaintenanceError("Forbidden", 403); } });
  await assert.rejects(run(f), /Forbidden/);
  assert.ok(!f.calls.some(({ method }) => method === "DELETE"));
});

test("a concurrent completed cleanup skips deletion; a creation race uses PATCH", async () => {
  const f = fixture({ caches: [cache], concurrentCompletion: true });
  assert.equal((await run(f)).status, "not-due");
  assert.ok(!f.calls.some(({ method }) => method === "DELETE"));
  const race = fixture({ raceCreation: true });
  assert.equal((await run(race)).status, "cleaned");
  assert.ok(race.calls.some(({ method }) => method === "PATCH"));
});

test("concurrent deletion returning 404 is success only when absence is verified", async () => {
  const f = fixture({ caches: [cache] });
  let deleted = false;
  const api = (method, path, options) => {
    if (method === "DELETE") { deleted = true; return Effect.fail(new GitHubMaintenanceError("Already gone", 404)); }
    if (deleted && path.includes("caches?")) return Effect.succeed([{ actions_caches: [] }]);
    return f.api(method, path, options);
  };
  assert.equal((await Effect.runPromise(maintainStorage({ api, now: () => now }))).status, "cleaned");
});

test("only the retired completed distribution workflow authorizes archive deletion", async () => {
  const f = fixture({ artifacts: [archive] });
  const api = (method, path, options) => path.endsWith("/actions/runs/34") ? Effect.succeed({ path: ".github/workflows/ci.yml", status: "completed", repository: { full_name: repository } }) : f.api(method, path, options);
  const result = await Effect.runPromise(maintainStorage({ api, now: () => now }));
  assert.equal(result.deleted, 0);
  assert.equal(result.preserved.length, 1);
});

test("Effect polling recovers from API failure and stops on interruption", async () => {
  let calls = 0;
  let warnings = 0;
  const api = () => Effect.sync(() => { calls++; }).pipe(Effect.andThen(Effect.fail(new GitHubMaintenanceError("Offline"))));
  const fiber = Effect.runFork(maintenanceLoop({ api, warn: () => warnings++, interval: 5 }));
  await Effect.runPromise(Effect.sleep(35));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const stopped = calls;
  await Effect.runPromise(Effect.sleep(15));
  assert.equal(calls, stopped);
  assert.ok(calls >= 2);
  assert.equal(warnings, calls);
});

test("CI and explicit opt-out never start GitHub maintenance", () => {
  startDevelopmentMaintenance({ env: { CI: "true" }, root: "/not-a-repository" }).stop();
  startDevelopmentMaintenance({ env: { ZELAVIS_GITHUB_MAINTENANCE: "0" }, root: "/not-a-repository" }).stop();
});

test("interrupting maintenance cancels a pending gh subprocess", async (t) => {
  if (process.platform === "win32") return t.skip("Executable fixture uses a POSIX shebang");
  const root = mkdtempSync(join(tmpdir(), "zelavis-gh-cancel-"));
  const started = join(root, "started");
  const stopped = join(root, "stopped");
  const executable = join(root, "gh");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(started)}, 'started');\nprocess.on('SIGTERM', () => { writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); });\nsetInterval(() => {}, 1000);\n`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const fiber = Effect.runFork(githubAPI(root)("GET", `repos/${repository}`));
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(started) && Date.now() < deadline) await Effect.runPromise(Effect.sleep(20));
    assert.ok(existsSync(started), "gh fixture started");
    await Effect.runPromise(Fiber.interrupt(fiber));
    const stopDeadline = Date.now() + 3000;
    while (!existsSync(stopped) && Date.now() < stopDeadline) await Effect.runPromise(Effect.sleep(20));
    assert.ok(existsSync(stopped), "gh received termination");
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
