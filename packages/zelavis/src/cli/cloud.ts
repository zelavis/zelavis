import { Data, Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis cloud <status|connect|disconnect|nodes|request|release> [node-id|request-id] " +
  "[--provider NAME] [--label TEXT] [--region NAME] [--url URL] [--token API_TOKEN] [--json]. " +
  "The provider token is read from the ZELAVIS_CLOUD_TOKEN environment variable, never from an option.";

const VALUE_FLAGS = ["--provider", "--label", "--region", "--url", "--token"];

class CloudUsageError extends Data.TaggedError("CloudUsageError")<{ readonly message: string }> {}

interface CloudArgs {
  readonly action: string | undefined;
  readonly id: string | undefined;
  readonly provider: string;
  readonly label: string | undefined;
  readonly region: string | undefined;
  readonly url: string;
  readonly apiToken: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
}

function parseCloudArgs(args: readonly string[]): CloudArgs {
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
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`Unknown cloud option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
  }
  const [action, id, ...rest] = positional;
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  return {
    action, id, json, help,
    provider: values.get("--provider") ?? "hetzner",
    label: values.get("--label"), region: values.get("--region"),
    url: values.get("--url") ?? "http://localhost:3000/zelavis",
    apiToken: values.get("--token"),
  };
}

const need = (value: string | undefined, label: string) =>
  value ? Effect.succeed(value) : Effect.fail(new CloudUsageError({ message: `${label} is required. ${usage}` }));

/**
 * `zelavis cloud`: cloud capacity through the JS SDK client (`client.cloud`), the same
 * contract as `/runtime/cloud`. The provider token comes from the environment so it never
 * lands in shell history or the process list.
 */
export function runCloudCommand(args: readonly string[]): Promise<void> {
  return present(Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseCloudArgs(args),
      catch: (error) => new CloudUsageError({ message: error instanceof Error ? error.message : String(error) }),
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

    switch (parsed.action) {
      case "status": {
        const connection = yield* integration(() => client.cloud.connection());
        print({ connection }, () => connection
          ? `${connection.provider} (${connection.label}), token ending ${connection.tokenHint}, connected by ${connection.connectedBy}`
          : "No cloud provider is connected.");
        return;
      }
      case "connect": {
        const token = yield* need(process.env.ZELAVIS_CLOUD_TOKEN, "The ZELAVIS_CLOUD_TOKEN environment variable");
        const connection = yield* integration(() => client.cloud.connect({
          provider: parsed.provider, token, ...(parsed.label === undefined ? {} : { label: parsed.label }),
        }));
        print({ connection }, () => `Connected ${connection.provider} (${connection.label}); the token is sealed and will not be shown again.`);
        return;
      }
      case "disconnect": {
        const result = yield* integration(() => client.cloud.disconnect());
        print(result, () => "Disconnected; the provider token is forgotten.");
        return;
      }
      case "nodes": {
        const nodes = yield* integration(() => client.cloud.nodes());
        print({ nodes }, () => nodes.map((node) => `${node.id}  ${node.state}${node.region ? `  ${node.region}` : ""}`).join("\n") || "No machines.");
        return;
      }
      case "request": {
        const requestId = yield* need(parsed.id, "A request id");
        const node = yield* integration(() => client.cloud.requestNode({ requestId, ...(parsed.region === undefined ? {} : { region: parsed.region }) }));
        print({ node }, () => `Requested ${node.id} (${node.state}). It is ready once it has enrolled.`);
        return;
      }
      case "release": {
        const nodeId = yield* need(parsed.id, "A node id");
        const result = yield* integration(() => client.cloud.releaseNode(nodeId));
        print(result, () => `Released ${nodeId}.`);
        return;
      }
      default:
        return yield* new CloudUsageError({ message: `Unknown cloud command "${parsed.action}". ${usage}` });
    }
  }));
}
