import type { CrossTenantIndexDefinition, CrossTenantIndexSummary, CrossTenantQueryResult, CrossTenantRefreshResult } from "../db/cross-tenant-index.js";
import { bodyFlag, integerFlag, jsonFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage =
  "zelavis cross-tenant-indexes <list|get|define|drop|refresh|query> --project ID [name] [--definition JSON] [--where JSON] [--order-by JSON] [--tenants A,B] [--search TEXT] [--limit N] [--after CURSOR] [--url URL] [--token TOKEN] [--json]";

const indexes = (input: CliInput) =>
  input.client.crossTenantIndexes(required({ ...input, positional: [input.flags.get("--project") ?? ""] }, 0, "cross-tenant-indexes commands need --project"));
const name = (input: CliInput) => required(input, 0, "An index name");

const summary = (index: CrossTenantIndexSummary) =>
  `${index.name}\t${index.collection}\t${index.partitions} partitions\t${index.refreshedAt ?? "not refreshed yet"}` +
  (index.failures.length === 0 ? "" : `\t${index.failures.length} unread: ${index.failures.map((failure) => `${failure.partition} (${failure.error})`).join(", ")}`);

/** A JSON flag that must be an array, or absent. */
const arrayFlag = (input: CliInput, flag: string) => {
  const value = jsonFlag(input, flag);
  if (value !== undefined && !Array.isArray(value)) throw new Error(`${flag} requires a JSON array.`);
  return value as never;
};

const table: CliTable = {
  name: "cross-tenant-indexes",
  usage,
  valued: ["--project", "--definition", "--where", "--order-by", "--tenants", "--search", "--limit", "--after"],
  actions: {
    list: {
      run: (input) => indexes(input).list(),
      text: (result: { indexes: readonly CrossTenantIndexSummary[] }) => result.indexes.map(summary).join("\n") || "No cross-Tenant indexes.",
    },
    get: { run: (input) => indexes(input).get(name(input)), text: summary },
    define: {
      run: (input) => indexes(input).define(bodyFlag<CrossTenantIndexDefinition>(input, "--definition", "cross-tenant-indexes define")),
      text: (result: CrossTenantIndexSummary) => `Defined ${result.name} over ${result.collection}; the next refresh fills it.`,
    },
    drop: {
      run: (input) => indexes(input).drop(name(input)),
      text: (result: { name: string; entries: number }) => `Dropped ${result.name} (${result.entries} entries).`,
    },
    refresh: {
      run: (input) => indexes(input).refresh(name(input)),
      text: (result: CrossTenantRefreshResult) =>
        `${result.index}: ${result.partitions} partitions, ${result.applied} applied, ${result.rederived} derived again, ${result.removed} removed` +
        (result.failures.length === 0 ? "" : `; unread: ${result.failures.map((failure) => `${failure.partition} (${failure.error})`).join(", ")}`),
    },
    query: {
      run: (input) => {
        const tenants = input.flags.get("--tenants");
        const limit = integerFlag(input, "--limit");
        return indexes(input).query(name(input), {
          ...(input.flags.has("--where") ? { where: arrayFlag(input, "--where") } : {}),
          ...(input.flags.has("--order-by") ? { orderBy: arrayFlag(input, "--order-by") } : {}),
          ...(tenants === undefined ? {} : { tenants: tenants.split(",").filter((tenant) => tenant.length > 0) }),
          ...(input.flags.has("--search") ? { search: input.flags.get("--search")! } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(input.flags.has("--after") ? { after: input.flags.get("--after")! as never } : {}),
        });
      },
      text: (result: CrossTenantQueryResult) =>
        [
          ...result.matches.map((match) => `${match.tenant}${match.part === undefined ? "" : `#${match.part}`}\t${match.id}\t${JSON.stringify(match.data)}`),
          ...(result.next === undefined ? [] : [`next: ${result.next}`]),
        ].join("\n") || "No matches.",
    },
  },
};

/**
 * `zelavis cross-tenant-indexes` — an App Project's cross-Tenant indexes, through the SDK client, so the CLI
 * cannot drift from `client.crossTenantIndexes(projectId)`.
 */
export function runCrossTenantIndexesCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
