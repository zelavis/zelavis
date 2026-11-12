import { required, runTable, type CliTable } from "./command-table.js";

const usage = "zelavis backends <list|detect|enable|disable|default> [backend-id] [--url URL] [--token TOKEN] [--json]";

const table: CliTable = {
  name: "backends",
  usage,
  valued: [],
  actions: {
    list: { run: (input) => input.client.deploymentBackends.list() },
    detect: { run: (input) => input.client.deploymentBackends.detect() },
    enable: { run: (input) => input.client.deploymentBackends.enable(required(input, 0, "A backend id")) },
    disable: { run: (input) => input.client.deploymentBackends.disable(required(input, 0, "A backend id")) },
    default: { run: (input) => input.client.deploymentBackends.setDefault(required(input, 0, "A backend id")) },
  },
};

/** `zelavis backends` — where the Platform may run Projects, through the SDK client. */
export function runBackendsCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
