import { required, runTable, type CliTable } from "./command-table.js";

const usage = "zelavis agent <status|operations|operation> [operation-id] [--url URL] [--token TOKEN] [--json]   (with no such word, `zelavis agent` runs the Agent)";

const table: CliTable = {
  name: "agent",
  usage,
  valued: [],
  actions: {
    status: { run: (input) => input.client.agent.status() },
    operations: { run: (input) => input.client.agent.operations() },
    operation: { run: (input) => input.client.agent.operation(required(input, 0, "An operation id")) },
  },
};

/** `zelavis agent status|operations|operation` — what the Agent reports, through the SDK client. */
export function runAgentStatusCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
