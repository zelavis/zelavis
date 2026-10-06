import { execFile } from "node:child_process";
import { Effect, Fiber } from "effect";
import { repositoryRoot } from "./reference-sources.mjs";

export const repository = "zelavis/zelavis";
export const timestampVariable = "ZELAVIS_ACTIONS_STORAGE_LAST_CLEANUP";
export const cleanupIntervalMs = 7 * 24 * 60 * 60 * 1000;
export const pollIntervalMs = 60 * 60 * 1000;
const minimumAgeMs = 24 * 60 * 60 * 1000;
const archiveNames = new Set(["zelavis-linux-x64", "zelavis-linux-arm64", "zelavis-darwin-x64", "zelavis-darwin-arm64"]);
const cacheKey = /^node-cache-(?:Linux|macOS|Windows)-(?:x64|arm64|arm|x86)-pnpm-[0-9a-f]{64}$/;
const base = `repos/${repository}`;

export class GitHubMaintenanceError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Each external process is bounded and cancelled with its owning Effect fiber.
const execute = (command, args, cwd) => Effect.callback((resume, signal) => {
  execFile(command, args, {
    cwd, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  }, (error, stdout, stderr) => {
    if (error) {
      const status = Number(stderr?.match(/HTTP (\d{3})/)?.[1]) || undefined;
      resume(Effect.fail(new GitHubMaintenanceError(
        `${command} request failed${status ? ` (HTTP ${status})` : error.code === "ENOENT" ? " (not installed)" : " (authentication, connection or process error)"}.`, status,
      )));
    } else resume(Effect.succeed(stdout.trim()));
  });
});

export function githubAPI(root = repositoryRoot) {
  return (method, path, { fields = {}, paginate = false } = {}) => execute("gh", [
    "api", "--hostname", "github.com", "--method", method, path,
    ...(paginate ? ["--paginate", "--slurp"] : []),
    ...Object.entries(fields).flatMap(([name, value]) => ["--raw-field", `${name}=${value}`]),
  ], root).pipe(Effect.flatMap((output) => Effect.try({
    try: () => output ? JSON.parse(output) : null,
    catch: () => new GitHubMaintenanceError("GitHub returned invalid JSON."),
  })));
}

function pages(response, key) {
  if (!Array.isArray(response) || response.some((page) => !Array.isArray(page?.[key]))) throw new GitHubMaintenanceError(`Invalid GitHub ${key} listing.`);
  return response.flatMap((page) => page[key]);
}

export function cleanupDue(value, now) {
  if (value === undefined) return true;
  // Malformed or future timestamps must not silently suppress maintenance.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || Date.parse(value) > now) {
    throw new GitHubMaintenanceError(`Invalid ${timestampVariable}; inspect the repository variable before retrying.`);
  }
  return now - Date.parse(value) >= cleanupIntervalMs;
}

function oldEnough(value, now) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now - minimumAgeMs;
}

export const inspectStorage = Effect.fn("github.storage.inspect")(function* (api, now) {
  const artifactPages = yield* api("GET", `${base}/actions/artifacts?per_page=100`, { paginate: true });
  const cachePages = yield* api("GET", `${base}/actions/caches?per_page=100`, { paginate: true });
  const artifacts = yield* Effect.try({ try: () => pages(artifactPages, "artifacts"), catch: (error) => error });
  const caches = yield* Effect.try({ try: () => pages(cachePages, "actions_caches"), catch: (error) => error });
  const deletions = [];
  const preserved = [];
  for (const cache of caches) {
    if (!Number.isSafeInteger(cache?.id) || cache.id <= 0) return yield* Effect.fail(new GitHubMaintenanceError("Invalid cache ID."));
    if (typeof cache.key === "string" && cacheKey.test(cache.key) && oldEnough(cache.last_accessed_at, now)) deletions.push({ kind: "cache", id: cache.id, name: cache.key });
    else preserved.push({ kind: "cache", id: cache.id, name: cache.key });
  }
  const runs = new Map();
  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0) return yield* Effect.fail(new GitHubMaintenanceError("Invalid artifact ID."));
    const runId = artifact.workflow_run?.id;
    if (archiveNames.has(artifact.name) && oldEnough(artifact.created_at, now) && Number.isSafeInteger(runId) && runId > 0) {
      if (!runs.has(runId)) runs.set(runId, yield* api("GET", `${base}/actions/runs/${runId}`));
      const run = runs.get(runId);
      if (run?.path === ".github/workflows/distribution.yml" && run.status === "completed" && run.repository?.full_name === repository) {
        deletions.push({ kind: "artifact", id: artifact.id, name: artifact.name });
        continue;
      }
    }
    preserved.push({ kind: "artifact", id: artifact.id, name: artifact.name });
  }
  return { artifacts: artifacts.length, caches: caches.length, deletions, preserved };
});

const getTimestamp = Effect.fn("github.storage.timestamp")(function* (api) {
  const response = yield* api("GET", `${base}/actions/variables?per_page=100`, { paginate: true });
  const variables = yield* Effect.try({ try: () => pages(response, "variables"), catch: (error) => error });
  const variable = variables.find((variable) => variable?.name === timestampVariable);
  if (variable && typeof variable.value !== "string") return yield* Effect.fail(new GitHubMaintenanceError("Invalid cleanup timestamp value."));
  return variable?.value;
});

export const maintainStorage = Effect.fn("github.storage.maintain")(function* ({ api = githubAPI(), now = () => Date.now(), mode = "clean" } = {}) {
  if (mode !== "clean" && mode !== "check") return yield* Effect.fail(new GitHubMaintenanceError("Expected check or clean mode."));
  const info = yield* api("GET", base);
  if (info?.full_name !== repository || info.permissions?.push !== true) return { status: "skipped", reason: "GitHub Write access is required." };
  const previous = yield* getTimestamp(api);
  const startedAt = now();
  const due = yield* Effect.try({ try: () => cleanupDue(previous, startedAt), catch: (error) => error });
  if (mode === "clean" && !due) return { status: "not-due", lastCleanup: previous };
  const plan = yield* inspectStorage(api, startedAt);
  if (mode === "check") return { status: "checked", due, lastCleanup: previous ?? null, ...plan };

  // Another maintainer may have completed a run while we inspected storage.
  const current = yield* getTimestamp(api);
  if (!(yield* Effect.try({ try: () => cleanupDue(current, now()), catch: (error) => error }))) return { status: "not-due", lastCleanup: current };
  let deleted = 0;
  for (const item of plan.deletions) {
    yield* api("DELETE", `${base}/actions/${item.kind === "cache" ? "caches" : "artifacts"}/${item.id}`).pipe(
      Effect.catch((error) => error.status === 404 ? Effect.void : Effect.fail(error)),
    );
    deleted++;
  }
  // A timestamp means every eligible deletion was verified absent, not just
  // that a run started. Failed runs remain due and can be retried.
  const remaining = yield* inspectStorage(api, startedAt);
  const stillPresent = new Set(remaining.deletions.map((item) => `${item.kind}:${item.id}`));
  if (plan.deletions.some((item) => stillPresent.has(`${item.kind}:${item.id}`))) return yield* Effect.fail(new GitHubMaintenanceError("Cleanup verification still found a selected item; timestamp was not updated."));
  const completedAt = new Date(now()).toISOString();
  const fields = { name: timestampVariable, value: completedAt };
  yield* api(current === undefined ? "POST" : "PATCH", current === undefined ? `${base}/actions/variables` : `${base}/actions/variables/${timestampVariable}`, { fields }).pipe(
    // Concurrent first runs may race creation; updating the same timestamp is
    // harmless. Variables are coordination hints, not an atomic global lock.
    Effect.catch((error) => current === undefined && error.status === 422
      ? api("PATCH", `${base}/actions/variables/${timestampVariable}`, { fields })
      : Effect.fail(error)),
  );
  const saved = yield* getTimestamp(api);
  if (!saved || Date.parse(saved) < Date.parse(completedAt)) return yield* Effect.fail(new GitHubMaintenanceError("Cleanup timestamp could not be verified."));
  return { status: "cleaned", deleted, lastCleanup: saved, ...remaining };
});

export const maintenanceLoop = Effect.fn("github.storage.loop")(function* ({ api = githubAPI(), now = () => Date.now(), log = console.log, warn = console.warn, interval = pollIntervalMs } = {}) {
  while (true) {
    yield* maintainStorage({ api, now }).pipe(
      Effect.tap((result) => Effect.sync(() => {
        if (result.status === "cleaned") log(`[GitHub maintenance] Cleanup complete: ${result.deleted} removed; ${result.preserved.length} preserved.`);
        else if (result.status === "skipped") log(`[GitHub maintenance] Skipped: ${result.reason}`);
      })),
      Effect.catch((error) => Effect.sync(() => warn(`[GitHub maintenance] ${error.message} Development continues; retrying at the next check.`))),
    );
    yield* Effect.sleep(interval);
  }
});

export function startDevelopmentMaintenance({ root = repositoryRoot, env = process.env, log = console.log, warn = console.warn } = {}) {
  if (env.CI || env.ZELAVIS_GITHUB_MAINTENANCE === "0") return { stop: () => {} };
  const program = Effect.scoped(Effect.gen(function* () {
    const origin = yield* execute("git", ["remote", "get-url", "origin"], root);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)zelavis\/zelavis(?:\.git)?\/?$/.test(origin)) {
      log("[GitHub maintenance] Skipped: origin is not zelavis/zelavis.");
      return;
    }
    log("[GitHub maintenance] Checking the shared cleanup timestamp now and hourly (cleanup every seven days).");
    yield* maintenanceLoop({ api: githubAPI(root), log, warn });
  })).pipe(Effect.catch((error) => Effect.sync(() => warn(`[GitHub maintenance] ${error.message} Development continues.`))));
  const fiber = Effect.runFork(program);
  return { stop: () => { Effect.runFork(Fiber.interrupt(fiber)); } };
}
