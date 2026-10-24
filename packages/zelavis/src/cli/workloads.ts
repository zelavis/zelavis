import { bodyFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";
import type { ZelavisWorkloadType } from "../sdk/fetch.js";

const usage =
  "zelavis workloads <health|menu|list|create|get|update|run|logs> --project ID [id|section] [--type function|job|schedule|webhook] [--data JSON] [--workload ID] [--url URL] [--token TOKEN] [--json]";

const workloads = (input: CliInput) => {
  const project = input.flags.get("--project");
  if (!project) throw new Error("workloads commands need --project.");
  return input.client.workloads(project);
};

const table: CliTable = {
  name: "workloads",
  usage,
  valued: ["--project", "--type", "--data", "--workload"],
  actions: {
    health: { run: (input) => workloads(input).health() },
    menu: { run: (input) => workloads(input).menu(required(input, 0, "A section (functions, jobs, schedules or webhooks)") as "functions") },
    list: {
      run: (input) => workloads(input).list(input.flags.has("--type") ? { type: input.flags.get("--type") as ZelavisWorkloadType } : undefined),
      text: (result: { workloads: readonly { id: string; type: string; name: string; enabled: boolean }[] }) =>
        result.workloads.map((entry) => `${entry.id}\t${entry.type}\t${entry.name}${entry.enabled ? "" : "\t(disabled)"}`).join("\n") || "No workloads.",
    },
    create: { run: (input) => workloads(input).create(bodyFlag(input, "--data", "workloads create")) },
    get: { run: (input) => workloads(input).get(required(input, 0, "A workload id")) },
    update: { run: (input) => workloads(input).update(required(input, 0, "A workload id"), bodyFlag(input, "--data", "workloads update")) },
    run: { run: (input) => workloads(input).run(required(input, 0, "A workload id")) },
    logs: { run: (input) => workloads(input).logs(input.flags.has("--workload") ? { workloadId: input.flags.get("--workload")! } : undefined) },
  },
};

/** `zelavis workloads` — the functions, jobs, schedules and webhooks of an App Project, through the SDK client. */
export function runWorkloadsCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
