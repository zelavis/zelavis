import { readFile } from "node:fs/promises";
import { createZelavisClient } from "../sdk/fetch.js";
import { readAllStdin } from "./prompt.js";

const usage = "zelavis plugins <namespace> <resource> <action> [--file input.json | --data '{...}' | --data-stdin] [--param name=value] [--query name=value] [--url URL] [--api-prefix /api] [--api-version v1] [--token TOKEN] [--json]";

/** All plugin commands dispatch through the same discovered SDK/HTTP contract. */
export async function runPluginsCommand(
  args: readonly string[],
  options?: { stdin?: NodeJS.ReadableStream },
): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let file: string | undefined;
  let data: string | undefined;
  let dataStdin = false;
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
    if (arg === "--data-stdin") { dataStdin = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }

    let flag = arg;
    let value: string | undefined;
    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      flag = arg.slice(0, eqIndex);
      value = arg.slice(eqIndex + 1);
    }

    if (!["--url", "--file", "--data", "--token", "--param", "--query", "--api-prefix", "--api-version"].includes(flag)) {
      throw new Error(`Unknown plugin option: ${arg}`);
    }

    if (value === undefined) {
      value = args[++index];
      if (value === undefined) throw new Error(`${flag} requires a value.`);
    }

    if (flag === "--url") url = value;
    if (flag === "--file") file = value;
    if (flag === "--data") data = value;
    if (flag === "--token") token = value;
    if (flag === "--api-prefix") apiPrefix = value;
    if (flag === "--api-version") apiVersion = value;
    if (flag === "--param" || flag === "--query") {
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error(`${flag} requires name=value.`);
      const target = flag === "--param" ? params : query;
      target[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }

  const payloadSources = [file !== undefined, data !== undefined, dataStdin].filter(Boolean).length;
  if (payloadSources > 1) {
    throw new Error("Use only one of --file, --data, or --data-stdin.");
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

  let input: unknown;
  if (data !== undefined) {
    try {
      input = JSON.parse(data);
    } catch {
      throw new Error("Invalid JSON in --data option.");
    }
  } else if (file === "-" || dataStdin) {
    const raw = await readAllStdin(options?.stdin);
    try {
      input = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      throw new Error("Invalid JSON from standard input.");
    }
  } else if (file) {
    input = JSON.parse(await readFile(file, "utf8"));
  }

  const result = await client.plugins[namespace!]![resource!]![action!]!(input, { params, query });
  console.log(JSON.stringify(result, null, 2));
}
