import { bodyFlag, integerFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage = "zelavis leases <show|put|audit> [PARTITION] [--data JSON] [--limit N] [--url URL] [--token TOKEN] [--json]";

const partition = (input: CliInput) => required(input, 0, "A partition (a Tenant, or a divided Tenant's part key)");

const table: CliTable = {
  name: "leases",
  usage,
  valued: ["--data", "--limit"],
  actions: {
    show: {
      run: (input) => input.client.writerLeases.get(partition(input)),
      text: (record: { lease: { owner: string; epoch: number; expiresAt: number; acknowledgedHead: number }; version: string }) =>
        `${record.lease.owner} at epoch ${record.lease.epoch}, ${record.lease.expiresAt === 0 ? "released" : `until ${new Date(record.lease.expiresAt).toISOString()}`}, acknowledged through ${record.lease.acknowledgedHead}\nversion ${record.version}`,
    },
    audit: {
      run: (input) => input.client.writerLeases.audit(integerFlag(input, "--limit") === undefined ? undefined : { limit: integerFlag(input, "--limit")! }),
      text: (result: { entries: ReadonlyArray<{ at: number; principal: string; partition: string; from?: { owner: string; epoch: number }; to: { owner: string; epoch: number }; lostPositions?: number }> }) =>
        result.entries.map((entry) => `${new Date(entry.at).toISOString()}\t${entry.partition}\t${entry.from === undefined ? "-" : `${entry.from.owner}@${entry.from.epoch}`} -> ${entry.to.owner}@${entry.to.epoch}\t${entry.principal}${entry.lostPositions === undefined ? "" : `\tLOST ${entry.lostPositions}`}`).join("\n") || "No changes of writer.",
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
