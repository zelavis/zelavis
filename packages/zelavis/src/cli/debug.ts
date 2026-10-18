import { Effect } from "effect";
import { integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createZelavisClient, type ZelavisProcessReport } from "../sdk/fetch.js";

const usage = "zelavis debug processes|updates|project <id> [--url URL] [--token TOKEN] [--json]";

const render = (report: ZelavisProcessReport) => {
  const lines = [`${report.processes.length} Zelavis process(es) of ${report.user} at ${report.generatedAt}${report.truncated ? " (list truncated)" : ""}`];
  for (const entry of report.processes) {
    lines.push(`${String(entry.pid).padStart(7)} ${String(entry.parentPid).padStart(7)} ${entry.startedAt} ${entry.elapsed.padStart(11)}${entry.projectId ? ` [${entry.projectId}]` : ""} ${entry.command}`);
  }
  if (report.duplicates.length > 0) {
    lines.push("", "Copies of one command running side by side:");
    for (const copy of report.duplicates) lines.push(`  pids ${copy.pids.join(", ")}${copy.projectId ? ` [${copy.projectId}]` : ""}: ${copy.command}`);
  }
  return lines.join("\n");
};

/** `zelavis debug processes` reads the Platform's diagnostics through the JS SDK client. */
const runDebugCommandProgram = Effect.fn("DebugCLI.run")(function* (args: readonly string[]): Effect.fn.Return<void, TaggedFailure> {
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false;
  const [subject, ...rest] = args;
  if (subject === "--help" || subject === "-h" || subject === undefined) { console.log(usage); return; }
  if (subject !== "processes" && subject !== "project" && subject !== "updates") return yield* new IntegrationFailure(new Error(`Unknown debug subject "${subject}". ${usage}`));
  let projectId: string | undefined;
  if (subject === "project") {
    projectId = rest.shift();
    if (!projectId || projectId.startsWith("--")) return yield* new IntegrationFailure(new Error(`debug project needs a Project id. ${usage}`));
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") { json = true; continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (flag !== "--url" && flag !== "--token") return yield* new IntegrationFailure(new Error(`Unknown debug option "${arg}". ${usage}`));
    const value = separator === -1 ? rest[++index] : arg.slice(separator + 1);
    if (!value) return yield* new IntegrationFailure(new Error(`${flag} requires a value.`));
    if (flag === "--url") url = value; else token = value;
  }
  const base = new URL(url);
  const client = createZelavisClient({ baseUrl: base.origin, rootPath: base.pathname, headers: token ? { authorization: `Bearer ${token}` } : undefined });
  if (projectId !== undefined) {
    const snapshot = yield* integration(() => client.debug.project(projectId));
    if (json) { console.log(JSON.stringify(snapshot, null, 2)); return; }
    const runtime = (snapshot.project.runtime ?? {}) as { status?: string; error?: string; url?: string };
    console.log([
      `Project ${projectId}: ${runtime.status ?? "unknown"}${runtime.error ? ` (${runtime.error})` : ""}${runtime.url ? ` at ${runtime.url}` : ""}`,
      `${snapshot.processes.length} process(es)${snapshot.duplicates.length ? `, ${snapshot.duplicates.length} command(s) running more than once` : ""}`,
      ...snapshot.processes.map((entry) => `  ${entry.pid} ${entry.startedAt} ${entry.command}`),
      `${snapshot.platformLog.length} Platform log entr${snapshot.platformLog.length === 1 ? "y" : "ies"} name it; ${snapshot.logs.length} runtime log line(s). Use --json for the record and the logs.`,
    ].join("\n"));
    return;
  }
  if (subject === "updates") {
    const { status, history } = yield* integration(() => client.debug.updates());
    if (json) { console.log(JSON.stringify({ status, history }, null, 2)); return; }
    const lines = [`Running ${status.current}${status.latest ? `, newest ${status.latest}` : ""}; update state: ${status.state}.`];
    if (history.length === 0) lines.push("No finished updates are kept yet.");
    for (const run of history) {
      lines.push("", `${run.finishedAt ?? run.startedAt}  ${run.state}  ${run.from} -> ${run.to ?? "?"}  ${run.message ?? ""}`);
      for (const line of run.log ?? []) lines.push(`    ${line}`);
    }
    console.log(lines.join("\n"));
    return;
  }
  const report = yield* integration(() => client.debug.processes());
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
});

export function runDebugCommand(args: readonly string[]): Promise<void> { return present(runDebugCommandProgram(args)); }
