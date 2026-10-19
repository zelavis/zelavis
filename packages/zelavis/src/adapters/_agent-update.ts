import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { arrayOf, isBoolean, isPositiveInteger, isString, objectFields, optional, parseJson } from "../core/json-validation.js";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { installationInstanceScope } from "../core/runtime/installation-instance.js";
import type { ZelavisUpdateRun } from "../updates.js";
import { createAgentProcessClient, type AgentInspection } from "./_agent-ipc.js";
import { prepareAgentHandover, readAgentDescriptor } from "./_agent-lifecycle.js";
import { requestNodeRuntimeControl } from "./_node-runtime-control.js";

interface AgentUpdateReport { readonly id: string; readonly target: string; readonly converted: boolean; readonly message: string; readonly degraded: boolean }
const reportSchema = objectFields<AgentUpdateReport>({ id: isString, target: isString, converted: isBoolean, message: isString, degraded: isBoolean });
const REPORT_FILE = "agent-updates.json";
const readBounded = Effect.fn("AgentUpdate.readBounded")(function* (path: string) {
  return yield* Effect.acquireUseRelease(integration(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)), file => Effect.gen(function* () {
    const stats = yield* integration(() => file.stat());
    yield* evaluate(() => { if (!stats.isFile() || stats.size > 64 * 1024) throw new Error("Agent update state must be a bounded regular file."); });
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = yield* integration(() => file.read(bytes, 0, bytes.length, 0));
    return yield* evaluate(() => { if (bytesRead > 64 * 1024) throw new Error("Agent update state exceeds its bound."); return bytes.subarray(0, bytesRead).toString("utf8"); });
  }), file => integration(() => file.close()).pipe(Effect.orDie));
});

const readReports = Effect.fn("AgentUpdate.readReports")(function* (directory: string) {
  const source = yield* readBounded(join(directory, REPORT_FILE)).pipe(Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed("[]")));
  return yield* evaluate(() => {
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error("Agent update reports exceed their bound.");
    const reports = parseJson(source, arrayOf(reportSchema));
    if (reports.length > 10) throw new Error("Too many Agent update reports.");
    return reports;
  });
});
/** Diagnostic enrichment works even when the update was run by an older
 * installed updater. This sidecar never grants execution or version authority. */
export const annotateAgentUpdate = Effect.fn("AgentUpdate.annotate")(function* (directory: string, run: ZelavisUpdateRun) {
  const reports = yield* readReports(directory).pipe(Effect.catch(error => Effect.logWarning(`Agent update diagnostics are unreadable: ${error.message}`).pipe(Effect.as([] as readonly AgentUpdateReport[]))));
  const report = reports.find(report => report.id === run.id && report.target === run.to);
  return report ? { ...run, ...(report.degraded && run.state === "succeeded" ? { state: "failed" as const } : {}),
    message: `${run.message ?? ""} ${report.message}`.trim() } : run;
});
const recordReport = Effect.fn("AgentUpdate.recordReport")(function* (directory: string, report: AgentUpdateReport) {
  const previous = yield* readReports(directory);
  const reports = [...previous.filter(item => item.id !== report.id), report].slice(-10);
  yield* integration(() => mkdir(directory, { recursive: true }));
  const temporary = join(directory, `.${REPORT_FILE}.${randomUUID()}`);
  yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o644)), file => Effect.gen(function* () {
      yield* integration(() => file.writeFile(`${JSON.stringify(reports)}\n`));
      yield* integration(() => file.sync());
    }), file => integration(() => file.close()).pipe(Effect.orDie));
    yield* integration(() => rename(temporary, join(directory, REPORT_FILE)));
  }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
});
const systemctl = Effect.fn("AgentUpdate.systemctl")(function* (args: readonly string[]) {
  yield* Effect.callback<void, IntegrationFailure>((resume, signal) => {
    const child = execFile("systemctl", [...args], { timeout: 10_000, maxBuffer: 64 * 1024, signal }, error =>
      resume(error ? Effect.fail(new IntegrationFailure(error)) : Effect.void));
    return Effect.sync(() => { child.kill(); });
  });
});
const inspect = Effect.fn("AgentUpdate.inspect")(function* (directory: string) {
  return yield* Effect.acquireUseRelease(integration(() => createAgentProcessClient({ directory, diagnostic: true, connectTimeoutMs: 500 })),
    client => integration(() => client.inspect()), client => integration(() => client.close()).pipe(Effect.orDie));
});
/** Single explicit conversion: the owned unit/cgroup has already stopped. No
 * PID read from these old records is ever signalled by the root installer. */
const removePreHandoverRecords = Effect.fn("AgentUpdate.removePreHandoverRecords")(function* (directory: string) {
  const names = yield* integration(() => readdir(directory)).pipe(Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed([] as string[])));
  if (names.length > 4096) return yield* new IntegrationFailure(new Error("Pre-handover records exceed their bound."));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const source = yield* readBounded(join(directory, name));
    const record = yield* evaluate(() => {
      if (Buffer.byteLength(source) > 64 * 1024) throw new Error("Pre-handover record exceeds its bound.");
      return parseJson(source, objectFields<{ pid: number; workloadId: string; executable: string; startedAt: string; ownerPid: number }>({ pid: isPositiveInteger, workloadId: isString, executable: isString, startedAt: isString, ownerPid: isPositiveInteger }));
    });
    const alive = yield* integration(() => readFile(`/proc/${record.pid}/stat`, "utf8")).pipe(Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(undefined)));
    if (alive && !["Z", "X"].includes(alive.slice(alive.lastIndexOf(")") + 2).split(" ")[0]!))
      return yield* new IntegrationFailure(new Error("A pre-handover process is still alive after its unit stopped; record retained."));
    yield* integration(() => rm(join(directory, name)));
  }
});

/** Prepare under the existing inventory hold, then return the replacement job.
 * Agent failure is reported as degraded; it never rolls a selected engine back.
 * Preparation holds the engine; replacement runs after root acknowledgement. */
export const prepareInstalledProjectAgentUpdate = Effect.fn("AgentUpdate.prepare")(function* (options: {
  readonly prefix: string; readonly instance: string; readonly dataDirectory: string;
  readonly target: string; readonly engineGeneration: number;
}) {
  const directory = join(options.dataDirectory, "agent"), updates = join(options.dataDirectory, "update");
  const source = yield* readBounded(join(updates, "status.json")).pipe(Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(undefined)));
  if (!source) return;
  const run = yield* evaluate(() => parseJson(source, objectFields<{ id: string; to?: string; state: string }>({ id: isString, to: optional(isString), state: isString })));
  // Manual selections and a failed candidate's rollback must not replace the
  // Agent with whatever older engine was selected. Status only correlates
  // diagnostics; the trusted installer supplies the actual release and unit.
  if (run.state !== "running" || run.to !== options.target) return;
  const observedBefore = yield* Effect.result(readAgentDescriptor(directory));
  const before = observedBefore._tag === "Success" ? observedBefore.success : undefined;
  if (before?.release === options.target && before.survivable) return;
  const unit = installationInstanceScope(options.prefix, options.instance).units[1]!;
  const converted = before?.survivable !== true, nonce = randomUUID();
  const control = (action: string) => requestNodeRuntimeControl(join(options.dataDirectory, "agent-update.sock"),
    { action, nonce, release: options.target, generation: options.engineGeneration });
  // Prepare the conversion hold while the persistent host still has external
  // admission drained. The caller acknowledges root inventory first, then runs
  // this job outside older hosts' 30-second commit deadline.
  const preparation = yield* Effect.result(observedBefore._tag === "Failure" ? Effect.fail(observedBefore.failure)
    : converted ? control("prepare").pipe(Effect.asVoid) : Effect.void);
  return Effect.gen(function* () {
  const outcome = yield* Effect.result(Effect.gen(function* () {
    if (preparation._tag === "Failure") return yield* preparation.failure;
    let processes: AgentInspection["processes"] = [];
    if (!converted) { processes = (yield* inspect(directory)).processes; yield* prepareAgentHandover(directory, options.target); }
    if (converted) {
      yield* systemctl(["stop", unit]);
      yield* systemctl(["kill", "--kill-who=all", "--signal=SIGKILL", unit]).pipe(Effect.catch(error => Effect.logInfo(`Pre-handover unit cgroup cleanup: ${error.message}`)));
      yield* removePreHandoverRecords(join(options.dataDirectory, "projects", ".agent-processes"));
      yield* systemctl(["start", unit]);
    } else yield* systemctl(["restart", unit]);
    const deadline = Date.now() + 12_000;
    let ready = false;
    while (Date.now() < deadline) {
      const descriptor = yield* readAgentDescriptor(directory);
      if (descriptor?.release === options.target && descriptor.pid !== before?.pid && descriptor.survivable) {
        const status = yield* Effect.result(inspect(directory));
        if (status._tag === "Success" && status.success.readySupervisors > 0) {
          const current = status.success;
          if (!converted && processes.some(process => process.running && !process.workloadId.startsWith("environment:") &&
            !current.processes.some(next => next.id === process.id && next.pid === process.pid && next.running && (!process.bound || next.bound))))
            return yield* new IntegrationFailure(new Error("Agent handover changed or failed to rebind a running Project process."));
          ready = true; break;
        }
      }
      yield* Effect.sleep(100);
    }
    if (!ready) return yield* new IntegrationFailure(new Error("Selected Agent did not become ready and rebind its clients."));
    if (converted) {
      yield* control("restore");
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const status = yield* control("status");
        if (status.phase === "ready") return;
        if (status.phase === "failed") return yield* new IntegrationFailure(new Error(String(status.failure)));
        yield* Effect.sleep(100);
      }
      // Preserve the healthy engine and let its bounded reconciliation finish,
      // but never report success before desired-running Projects are proved back.
      return yield* new IntegrationFailure(new Error("Agent converted, but Project recovery did not finish before its reporting deadline. Check Project diagnostics."));
    }
  }).pipe(Effect.timeoutOrElse({ duration: 95_000, orElse: () => Effect.fail(new IntegrationFailure(new Error("Agent update exceeded its bounded recovery window."))) })));
  const message = outcome._tag === "Failure"
    ? `Platform ${options.target} remains selected; Project Agent is degraded: ${outcome.failure.message}`
    : converted ? "The old Project Agent was converted; Projects restarted once. Subsequent Agent updates preserve their processes."
      : `Project Agent updated to ${options.target} without restarting Projects.`;
  yield* recordReport(updates, { id: run.id, target: options.target, converted, degraded: outcome._tag === "Failure", message });
  console.log(message);
  });
});
