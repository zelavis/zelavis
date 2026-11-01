import { bodyFlag, runTable, type CliTable } from "./command-table.js";

const usage = "zelavis runtime <config|access|settings|update-settings> [--data JSON] [--url URL] [--token TOKEN] [--json]";

const table: CliTable = {
  name: "runtime",
  usage,
  valued: ["--data"],
  actions: {
    config: { run: (input) => input.client.runtime.config() },
    access: { run: (input) => input.client.runtime.access() },
    settings: { run: (input) => input.client.runtime.settings() },
    "update-settings": { run: (input) => input.client.runtime.updateSettings(bodyFlag(input, "--data", "runtime update-settings") as never) },
  },
};

/** `zelavis runtime` — the Platform's configuration, the caller's access and the dashboard settings, through the SDK client. */
export function runRuntimeCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
