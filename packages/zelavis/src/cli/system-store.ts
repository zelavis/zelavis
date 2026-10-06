import { Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage = "zelavis system-store <namespaces|records NAMESPACE> [--limit N] [--after KEY] [--url URL] [--token TOKEN] [--json]";
function parse(args: readonly string[]) {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") return undefined;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (!["--limit", "--after", "--url", "--token"].includes(arg)) throw new Error(`Unknown system-store option "${arg}".`);
    const value = args[++index];
    if (value === undefined || value === "") throw new Error(`${arg} requires a value.`);
    options[arg] = value;
  }
  const [action, namespace, extra] = positional;
  if (!action) return undefined;
  if (extra || action !== "namespaces" && action !== "records" || action === "records" && !namespace || action === "namespaces" && namespace) {
    throw new Error(usage);
  }
  const limit = options["--limit"] === undefined ? undefined : Number(options["--limit"]);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new Error("--limit must be from 1 to 200.");
  return { action, namespace, limit, after: options["--after"], url: options["--url"] ?? "http://localhost:3000/zelavis", token: options["--token"], json };
}
const run = Effect.fn("cli.systemStore")(function* (args: readonly string[]) {
  const input = parse(args);
  if (!input) { console.log(usage); return; }
  const base = new URL(input.url);
  const client = createZelavisClient({ baseUrl: base.origin, rootPath: base.pathname,
    headers: input.token ? { authorization: `Bearer ${input.token}` } : undefined });
  if (input.action === "namespaces") {
    const namespaces = yield* integration(() => client.runtime.systemStore.namespaces());
    console.log(input.json ? JSON.stringify({ namespaces }, null, 2) :
      namespaces.map(row => `${row.namespace}\t${row.recordCount}`).join("\n") || "No backend tables.");
  } else {
    const page = yield* integration(() => client.runtime.systemStore.records(input.namespace!, { limit: input.limit, after: input.after }));
    console.log(input.json ? JSON.stringify(page, null, 2) :
      page.records.map(row => `${row.key}\t${row.updatedAt}\t${JSON.stringify(row.value)}`).join("\n") +
      (page.next ? `\nNext page: --after ${JSON.stringify(page.next)}` : ""));
  }
});
export function runSystemStoreCommand(args: readonly string[]): Promise<void> { return present(run(args)); }
