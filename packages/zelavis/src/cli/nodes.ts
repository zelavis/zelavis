import { readFile, writeFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis nodes <list|platform|enroll-token|enroll|remove> [node-id] [--ttl-minutes N] [--replace] " +
  "[--enrollment-token TOKEN --cert-file FILE --agent-url URL [--trust-out FILE]] " +
  "[--url URL] [--token API_TOKEN] [--json]";

interface NodesArgs {
  readonly action: string | undefined;
  readonly nodeId: string | undefined;
  readonly url: string;
  readonly apiToken: string | undefined;
  readonly json: boolean;
  readonly ttlMinutes: number | undefined;
  readonly replace: boolean;
  readonly enrollmentToken: string | undefined;
  readonly certFile: string | undefined;
  readonly agentUrl: string | undefined;
  readonly trustOut: string | undefined;
  readonly help: boolean;
}

const VALUE_FLAGS = ["--url", "--token", "--ttl-minutes", "--enrollment-token", "--cert-file", "--agent-url", "--trust-out"];

/** Plain synchronous parsing; every failure is a thrown Error the dispatcher reports. */
function parseNodesArgs(args: readonly string[]): NodesArgs {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let replace = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--replace") { replace = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`Unknown nodes option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
  }
  const [action, nodeId, ...rest] = positional;
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  const ttl = values.get("--ttl-minutes");
  if (ttl !== undefined && !/^[1-9][0-9]*$/.test(ttl)) throw new Error("--ttl-minutes must be a whole number.");
  return {
    action, nodeId, json, replace, help,
    url: values.get("--url") ?? "http://localhost:3000/zelavis",
    apiToken: values.get("--token"),
    ttlMinutes: ttl === undefined ? undefined : Number(ttl),
    enrollmentToken: values.get("--enrollment-token"),
    certFile: values.get("--cert-file"),
    agentUrl: values.get("--agent-url"),
    trustOut: values.get("--trust-out"),
  };
}

/** Bad usage: reported with its message and a non-zero exit, never a stack trace. */
class NodesUsageError extends Data.TaggedError("NodesUsageError")<{ readonly message: string }> {}

const need = (value: string | undefined, label: string) =>
  value ? Effect.succeed(value) : Effect.fail(new NodesUsageError({ message: `${label} is required. ${usage}` }));

/**
 * `zelavis nodes` — machines that join this Platform, through the JS SDK client
 * (`client.nodes`), the same contract as `/runtime/nodes`.
 *
 * `enroll-token` issues a single-use credential and shows it once. `enroll` is
 * what the joining machine runs: it presents the credential and its own
 * certificate, and can write the Platform's trust keys to a file for its Agent.
 */
export function runNodesCommand(args: readonly string[]): Promise<void> {
  return present(Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseNodesArgs(args),
      catch: (error) => new NodesUsageError({ message: error instanceof Error ? error.message : String(error) }),
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
      case "list": {
        const result = yield* integration(() => client.nodes.list());
        print(result, () => [
          ...result.nodes.map((node) => `${node.nodeId}  ${node.state}  ${node.url}  enrolled ${new Date(node.enrolledAt).toISOString()}`),
          ...result.enrollments.filter((e) => e.state === "unused").map((e) => `${e.nodeId}  pending  expires ${new Date(e.expiresAt).toISOString()}`),
        ].join("\n") || "No nodes.");
        return;
      }
      case "platform": {
        const endpoint = yield* integration(() => client.nodes.platform());
        print({ endpoint }, () => endpoint
          ? `${endpoint.url}\nsha256:${endpoint.fingerprint}`
          : "This installation serves no enrollment endpoint.");
        return;
      }
      case "enroll-token": {
        const nodeId = yield* need(parsed.nodeId, "A node id");
        const issued = yield* integration(() => client.nodes.createEnrollment({
          nodeId,
          ...(parsed.ttlMinutes === undefined ? {} : { ttlMinutes: parsed.ttlMinutes }),
          ...(parsed.replace ? { replace: true } : {}),
        }));
        print(issued, () =>
          `Enrollment token for ${issued.nodeId} (expires ${new Date(issued.expiresAt).toISOString()}). It is shown once:\n${issued.token}`);
        return;
      }
      case "enroll": {
        const nodeId = yield* need(parsed.nodeId, "A node id");
        const token = yield* need(parsed.enrollmentToken, "--enrollment-token");
        const certFile = yield* need(parsed.certFile, "--cert-file");
        const agentUrl = yield* need(parsed.agentUrl, "--agent-url");
        const certPem = yield* integration(() => readFile(certFile, "utf8"));
        const result = yield* integration(() => client.nodes.enroll({ nodeId, token, certPem, url: agentUrl }));
        if (parsed.trustOut) {
          yield* integration(() => writeFile(parsed.trustOut!, `${JSON.stringify(result.trust, null, 2)}\n`, { mode: 0o644 }));
        }
        print(result, () => `Enrolled ${result.nodeId} as ${result.agentId}.${parsed.trustOut ? ` Trust keys written to ${parsed.trustOut}.` : ""}`);
        return;
      }
      case "remove": {
        const nodeId = yield* need(parsed.nodeId, "A node id");
        const result = yield* integration(() => client.nodes.remove(nodeId));
        print(result, () => `Revoked ${nodeId}.`);
        return;
      }
      default:
        return yield* new NodesUsageError({ message: `Unknown nodes command "${parsed.action}". ${usage}` });
    }
  }));
}
