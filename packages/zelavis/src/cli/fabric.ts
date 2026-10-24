import { jsonFlag, required, runTable, type CliTable } from "./command-table.js";

const usage = "zelavis fabric <snapshot|health|nodes|node|placements|placement|plan|migrations> [id] [--data JSON] [--url URL] [--token TOKEN] [--json]";

const table: CliTable = {
  name: "fabric",
  usage,
  valued: ["--data"],
  actions: {
    snapshot: { run: (input) => input.client.fabric.snapshot() },
    health: { run: (input) => input.client.fabric.health() },
    nodes: { run: (input) => input.client.fabric.nodes() },
    node: { run: (input) => input.client.fabric.node(required(input, 0, "A node id")) },
    placements: { run: (input) => input.client.fabric.placements() },
    placement: { run: (input) => input.client.fabric.placement(required(input, 0, "A Project id")) },
    plan: {
      run: (input) => {
        const requests = jsonFlag(input, "--data");
        if (!Array.isArray(requests)) throw new Error("fabric plan requires --data with a JSON array of placement requests.");
        return input.client.fabric.plan(requests);
      },
    },
    migrations: { run: (input) => input.client.fabric.migrations() },
  },
};

/** `zelavis fabric` — the Fabric's nodes, placements and migrations, through the SDK client. */
export function runFabricCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
