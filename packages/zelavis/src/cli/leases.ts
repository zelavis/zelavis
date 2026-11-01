import { bodyFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage = "zelavis leases <show|put> PARTITION [--data JSON] [--url URL] [--token TOKEN] [--json]";

const partition = (input: CliInput) => required(input, 0, "A partition (a Tenant, or a divided Tenant's part key)");

const table: CliTable = {
  name: "leases",
  usage,
  valued: ["--data"],
  actions: {
    show: {
      run: (input) => input.client.writerLeases.get(partition(input)),
      text: (record: { lease: { owner: string; epoch: number; expiresAt: number; acknowledgedHead: number }; version: string }) =>
        `${record.lease.owner} at epoch ${record.lease.epoch}, ${record.lease.expiresAt === 0 ? "released" : `until ${new Date(record.lease.expiresAt).toISOString()}`}, acknowledged through ${record.lease.acknowledgedHead}\nversion ${record.version}`,
    },
    // `--data '{"lease": {...}, "expectedVersion": "..."}'`: without expectedVersion the lease is created.
    put: {
      run: (input) => input.client.writerLeases.put(partition(input), bodyFlag(input, "--data", "leases put")),
      text: () => "Written.",
    },
  },
};

/** `zelavis leases` — the Platform's writer-lease authority, through the SDK client. Holders use it conditionally (`put`). */
export function runLeasesCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
