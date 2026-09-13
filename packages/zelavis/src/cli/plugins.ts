import { readFile } from "node:fs/promises";
import { createZelavisClient } from "../sdk/fetch.js";

const usage = "zelavis plugins <namespace> <resource> <action> [--file input.json] [--param name=value] [--query name=value] [--url URL] [--api-prefix /api] [--api-version v1] [--token TOKEN] [--json]";

/** All plugin commands dispatch through the same discovered SDK/HTTP contract. */
export async function runPluginsCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let file: string | undefined;
  let token: string | undefined;
  let apiPrefix: string | undefined;
  let apiVersion: string | undefined;
  let help = false;
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--json") continue; // JSON is also the default output.
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (!["--url", "--file", "--token", "--param", "--query", "--api-prefix", "--api-version"].includes(arg)) throw new Error(`Unknown plugin option: ${arg}`);
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value.`);
    if (arg === "--url") url = value;
    if (arg === "--file") file = value;
    if (arg === "--token") token = value;
    if (arg === "--api-prefix") apiPrefix = value;
    if (arg === "--api-version") apiVersion = value;
    if (arg === "--param" || arg === "--query") {
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error(`${arg} requires name=value.`);
      const target = arg === "--param" ? params : query;
      target[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }
  if (positional.length > 3) throw new Error("Use zelavis plugins <namespace> <resource> <action>.");
  if (help && positional.length === 0) {
    console.log(JSON.stringify({ usage }, null, 2));
    return;
  }
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    apiPrefix,
    apiVersion,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const [namespace, resource, action] = positional;
  if (help || positional.length < 3) {
    const operations = (await client.pluginOperations()).filter((operation) =>
      (!namespace || operation.namespace === namespace) && (!resource || operation.resource === resource));
    console.log(JSON.stringify({
      usage,
      operations,
    }, null, 2));
    return;
  }
  const input = file ? JSON.parse(await readFile(file, "utf8")) : undefined;
  const result = await client.plugins[namespace!]![resource!]![action!]!(input, { params, query });
  console.log(JSON.stringify(result, null, 2));
}
