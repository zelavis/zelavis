import { bodyFlag, integerFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage =
  "zelavis followers <stats|records|log|hold|release|acknowledge|acknowledgments|changes> --project ID [partition] [--after ID|CURSOR] [--from CURSOR] [--limit N] [--id HOLD] [--position N] [--ttl-millis N] [--follower NAME] [--heads JSON] [--partitions A,B] [--timeout-millis N] [--url URL] [--token TOKEN] [--json]";

const followers = (input: CliInput) =>
  input.client.followers(required({ ...input, positional: [input.flags.get("--project") ?? ""] }, 0, "followers commands need --project"));
const partition = (input: CliInput) => required(input, 0, "A partition (a Tenant, or a divided Tenant's part key)");
const needed = (input: CliInput, flag: string) => {
  const value = integerFlag(input, flag);
  if (value === undefined) throw new Error(`${flag} is required.`);
  return value;
};

const table: CliTable = {
  name: "followers",
  usage,
  valued: ["--project", "--after", "--from", "--limit", "--id", "--position", "--ttl-millis", "--follower", "--heads", "--partitions", "--timeout-millis"],
  actions: {
    stats: {
      run: (input) => followers(input).stats(partition(input)),
      text: (stats: { records: number; head: number; compactedTo: number; seeding: boolean }) =>
        `${stats.records} records, head ${stats.head}, compacted to ${stats.compactedTo}${stats.seeding ? ", seed unfinished" : ""}`,
    },
    records: {
      run: (input) => {
        const after = integerFlag(input, "--after");
        return followers(input).records(partition(input), { ...(after === undefined ? {} : { after }), limit: integerFlag(input, "--limit") ?? 256 });
      },
    },
    log: {
      run: (input) => followers(input).log(partition(input), {
        ...(input.flags.has("--after") ? { after: input.flags.get("--after")! } : {}),
        ...(input.flags.has("--from") ? { from: input.flags.get("--from")! } : {}),
        limit: integerFlag(input, "--limit") ?? 256,
      }),
    },
    hold: {
      run: (input) => followers(input).hold(partition(input), {
        id: required({ ...input, positional: [input.flags.get("--id") ?? ""] }, 0, "--id"),
        position: needed(input, "--position"),
        ttlMillis: needed(input, "--ttl-millis"),
      }),
      text: (result: { position: number }) => `Held at ${result.position}.`,
    },
    release: {
      run: (input) => followers(input).release(partition(input), required({ ...input, positional: [input.flags.get("--id") ?? ""] }, 0, "--id")),
      text: () => "Released.",
    },
    acknowledge: {
      run: (input) => followers(input).acknowledge(partition(input), {
        follower: required({ ...input, positional: [input.flags.get("--follower") ?? ""] }, 0, "--follower"),
        position: needed(input, "--position"),
      }),
      text: (result: { follower: string; position: number }) => `${result.follower} holds through ${result.position}.`,
    },
    acknowledgments: {
      run: (input) => followers(input).acknowledgments(partition(input)),
      text: (result: { followers: ReadonlyArray<{ name: string; position: number }> }) =>
        result.followers.map((follower) => `${follower.name}\t${follower.position}`).join("\n") || "No follower has reported.",
    },
    changes: {
      run: (input) => {
        const partitions = input.flags.get("--partitions");
        const timeoutMillis = integerFlag(input, "--timeout-millis");
        return followers(input).changes({
          ...(input.flags.has("--heads") ? { heads: bodyFlag<Record<string, number>>(input, "--heads", "followers changes") } : {}),
          ...(partitions === undefined ? {} : { partitions: partitions.split(",").filter((name) => name.length > 0) }),
          ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
        });
      },
      text: (result: { heads: Record<string, number>; more: boolean }) =>
        [...Object.entries(result.heads).map(([name, head]) => `${name}\t${head}`), ...(result.more ? ["more: ask again"] : [])].join("\n") || "Nothing moved.",
    },
  },
};

/**
 * `zelavis followers` — the leader side of an App Project's database for followers on other hosts, through the SDK
 * client, so the CLI cannot drift from `client.followers(projectId)`.
 */
export function runFollowersCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
