import type { ZelavisShardDescription, ZelavisShardOperation } from "../sdk/fetch.js";
import { integerFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage =
  "zelavis shards <list|place|release|replicate|unreplicate|operation> --project ID [shard] [--ranges 0-31,64] [--cpu N] [--memory BYTES] [--disk BYTES] [--shard ID] [--into SHARD] [--url URL] [--token TOKEN] [--json]";

const shards = (input: CliInput) =>
  input.client.shards(required({ ...input, positional: [input.flags.get("--project") ?? ""] }, 0, "shards commands need --project"));

/** `0-3,9` is the integers 0, 1, 2, 3 and 9: comma-separated integers and inclusive `a-b` spans. */
export const parseRanges = (text: string): number[] => {
  const out: number[] = [];
  for (const part of text.split(",")) {
    const span = /^(\d+)-(\d+)$/.exec(part.trim());
    if (span !== null) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      if (from > to) throw new Error(`--ranges span ${part} runs backwards.`);
      if (to - from >= 4096) throw new Error(`--ranges span ${part} is longer than 4096.`);
      for (let value = from; value <= to; value++) out.push(value);
    } else if (/^\d+$/.test(part.trim())) {
      out.push(Number(part.trim()));
    } else {
      throw new Error(`--ranges takes comma-separated integers and a-b spans, not "${part}".`);
    }
  }
  return out;
};

const needed = (input: CliInput, flag: string) => {
  const value = integerFlag(input, flag);
  if (value === undefined) throw new Error(`${flag} is required.`);
  return value;
};

const describeOperation = (operation: { kind: string; shardId: string; phase: string; nodeId?: string; error?: string } | null) =>
  operation === null
    ? "No shard operation."
    : `${operation.kind} ${operation.shardId}: ${operation.phase}${operation.nodeId === undefined ? "" : ` on ${operation.nodeId}`}${operation.error === undefined ? "" : ` (${operation.error})`}`;

const describeReplica = (replica: ZelavisShardDescription["replica"]) => replica === undefined
  ? ""
  : ` · replica on ${replica.nodeId ?? "unknown Node"} (${replica.status}${replica.lagMillis === undefined ? "" : `, ${replica.lagMillis} ms behind`})`;

const table: CliTable = {
  name: "shards",
  usage,
  valued: ["--project", "--ranges", "--cpu", "--memory", "--disk", "--shard", "--into"],
  actions: {
    list: {
      run: (input) => shards(input).list(),
      text: (result: { shards: ReadonlyArray<ZelavisShardDescription>; operation: ZelavisShardOperation | null }) =>
        [
          ...result.shards.map((shard) => `${shard.shardId}\t${shard.location}${shard.nodeId === undefined ? "" : ` (${shard.nodeId}, ${shard.state ?? "unknown"}${shard.available === false ? ", NOT ANSWERING" : ""})`}\t${shard.virtualRanges} ranges${describeReplica(shard.replica)}`),
          describeOperation(result.operation),
        ].join("\n"),
    },
    place: {
      run: (input) => {
        const ranges = input.flags.get("--ranges");
        if (ranges === undefined) throw new Error("--ranges is required.");
        return shards(input).place({
          virtualRanges: parseRanges(ranges),
          resources: { cpuCores: needed(input, "--cpu"), memoryBytes: needed(input, "--memory"), diskBytes: needed(input, "--disk") },
          ...(input.flags.has("--shard") ? { shardId: input.flags.get("--shard")! } : {}),
        });
      },
      text: describeOperation,
    },
    release: {
      run: (input) => shards(input).release(required(input, 0, "A shard"), {
        into: required({ ...input, positional: [input.flags.get("--into") ?? ""] }, 0, "--into"),
      }),
      text: describeOperation,
    },
    replicate: {
      run: (input) => shards(input).replicate(required(input, 0, "A shard"), { diskBytes: needed(input, "--disk") }),
      text: describeOperation,
    },
    unreplicate: {
      run: (input) => shards(input).unreplicate(required(input, 0, "A shard")),
      text: describeOperation,
    },
    operation: {
      run: (input) => shards(input).operation(),
      text: describeOperation,
    },
  },
};

/**
 * `zelavis shards` — an App Project's shards on other Nodes, through the SDK client, so the CLI cannot drift from
 * `client.shards(projectId)`.
 */
export function runShardsCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
