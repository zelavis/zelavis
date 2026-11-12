import { Data, Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { createZelavisClient, ZelavisClientHttpError } from "../sdk/fetch.js";

const usage =
  "zelavis shard-placement <get|set-allocation> <project-id> " +
  "[--nodes a,b --cpu N --memory BYTES --disk BYTES --expected-generation N] " +
  "[--url URL] [--token API_TOKEN] [--json]";

interface ShardPlacementArgs {
  readonly action: string | undefined;
  readonly projectId: string | undefined;
  readonly url: string;
  readonly apiToken: string | undefined;
  readonly json: boolean;
  readonly nodes: readonly string[] | undefined;
  readonly cpu: number | undefined;
  readonly memory: number | undefined;
  readonly disk: number | undefined;
  readonly expectedGeneration: number | undefined;
  readonly help: boolean;
}

const VALUE_FLAGS = ["--url", "--token", "--nodes", "--cpu", "--memory", "--disk", "--expected-generation"];

const wholeNumber = (flag: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a whole number.`);
  return parsed;
};

/** Plain synchronous parsing; every failure is a thrown Error the dispatcher reports. */
function parseShardPlacementArgs(args: readonly string[]): ShardPlacementArgs {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`Unknown shard-placement option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
  }
  const [action, projectId, ...rest] = positional;
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  const nodes = values.get("--nodes");
  return {
    action, projectId, json, help,
    url: values.get("--url") ?? "http://localhost:3000/zelavis",
    apiToken: values.get("--token"),
    nodes: nodes === undefined ? undefined : nodes.split(",").map((id) => id.trim()).filter((id) => id.length > 0),
    cpu: wholeNumber("--cpu", values.get("--cpu")),
    memory: wholeNumber("--memory", values.get("--memory")),
    disk: wholeNumber("--disk", values.get("--disk")),
    expectedGeneration: wholeNumber("--expected-generation", values.get("--expected-generation")),
  };
}

/** Bad usage: reported with its message and a non-zero exit, never a stack trace. */
class ShardPlacementUsageError extends Data.TaggedError("ShardPlacementUsageError")<{ readonly message: string }> {}

const need = <T>(value: T | undefined, label: string) =>
  value !== undefined && value !== "" ? Effect.succeed(value) : Effect.fail(new ShardPlacementUsageError({ message: `${label} is required. ${usage}` }));

/**
 * `zelavis shard-placement` — a Project's remote App shard allocation and placements, through the JS SDK client
 * (`client.shardPlacement`), the same contract as `/runtime/shard-placement`. A refusal prints the server's error
 * (and its code with `--json`) and exits non-zero.
 */
export function runShardPlacementCommand(args: readonly string[]): Promise<void> {
  return present(Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseShardPlacementArgs(args),
      catch: (error) => new ShardPlacementUsageError({ message: error instanceof Error ? error.message : String(error) }),
    });
    if (parsed.help || !parsed.action) {
      console.log(usage);
      return;
    }
    const base = new URL(parsed.url);
    const client = createZelavisClient({
      baseUrl: base.origin,
      rootPath: base.pathname,
      headers: parsed.apiToken ? { authorization: `Bearer ${parsed.apiToken}` } : undefined,
    });
    const print = (value: unknown, text: () => string) =>
      console.log(parsed.json ? JSON.stringify(value, null, 2) : text());
    const projectId = yield* need(parsed.projectId, "A project id");

    const call = <T>(operation: () => Promise<T>) => integration(operation).pipe(
      Effect.tapError((error) => Effect.sync(() => {
        const cause: unknown = (error as { readonly cause?: unknown }).cause ?? error;
        if (parsed.json && cause instanceof ZelavisClientHttpError) {
          console.log(JSON.stringify({ error: cause.message, code: cause.code ?? null }, null, 2));
        }
      })),
    );

    switch (parsed.action) {
      case "get": {
        const view = yield* call(() => client.shardPlacement.get(projectId));
        print(view, () => [
          view.allocation
            ? `allocation ${view.allocation.generation}: nodes ${view.allocation.allowedNodeIds.join(",")} cpu ${view.allocation.cpuCores} memory ${view.allocation.memoryBytes} disk ${view.allocation.diskBytes}`
            : "no allocation",
          ...view.placements.map((placement) => `${placement.shardId}  ${placement.state}  ${placement.nodeId}  epoch ${placement.epoch}  ranges ${placement.virtualRanges.join(",")}`),
        ].join("\n"));
        return;
      }
      case "set-allocation": {
        const nodes = yield* need(parsed.nodes && parsed.nodes.length > 0 ? parsed.nodes : undefined, "--nodes");
        const cpuCores = yield* need(parsed.cpu, "--cpu");
        const memoryBytes = yield* need(parsed.memory, "--memory");
        const diskBytes = yield* need(parsed.disk, "--disk");
        const expectedGeneration = yield* need(parsed.expectedGeneration, "--expected-generation");
        const allocation = yield* call(() => client.shardPlacement.setAllocation(projectId, {
          allowedNodeIds: nodes, cpuCores, memoryBytes, diskBytes, expectedGeneration,
        }));
        print({ allocation }, () => `Allocation ${allocation.generation} set for ${projectId}.`);
        return;
      }
      default:
        return yield* new ShardPlacementUsageError({ message: `Unknown shard-placement command "${parsed.action}". ${usage}` });
    }
  }));
}
