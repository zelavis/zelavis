import { Data, Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLocalDataOwnership } from "../adapters/_local-ownership.js";
import { createLocalSqliteSystemStore } from "../adapters/_sqlite-system-store.js";
import { isString, objectFields, parseJson } from "../core/json-validation.js";
import { resolveCliDataDirectory } from "./data-directory.js";

const usage = "zelavis system-store <namespaces|records NAMESPACE> [--limit N] [--after KEY] [--url URL] [--token TOKEN] [--json]\n" +
  "       zelavis system-store import RECORDS.jsonl --confirm import [--replace] [--data-dir DIR]   (host-local, Platform stopped)";
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
class SystemStoreImportRefused extends Data.TaggedError("SystemStoreImportRefused")<{ readonly message: string }> {}

const recordLine = objectFields<{ namespace: string; key: string; value: unknown }>({ namespace: isString, key: isString, value: (_value: unknown): _value is unknown => true });

/**
 * Apply a restored Platform backup's System Store records (`system-store/records.jsonl`) to this host's store.
 * Host-local and with the Platform stopped: it takes the Platform's data ownership for maintenance, so it is
 * refused while the Platform runs, and it refuses a store that holds records unless told to replace them.
 */
const importRecords = Effect.fn("cli.systemStore.import")(function* (args: readonly string[]) {
  let file: string | undefined, dataDir: string | undefined, confirm: string | undefined, replace = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--replace") { replace = true; continue; }
    if (arg === "--data-dir" || arg === "--confirm") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === "--data-dir") dataDir = value; else confirm = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown system-store import option "${arg}".`);
    if (file !== undefined) throw new Error(usage);
    file = arg;
  }
  if (file === undefined) throw new Error("zelavis system-store import needs the restored records.jsonl.");
  if (confirm !== "import") throw new Error("Importing replaces Platform authority; repeat with --confirm import, with the Platform stopped.");
  const directory = resolveCliDataDirectory(dataDir);
  const lines = (yield* integration(() => readFile(file!, "utf8"))).split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line, at) => {
    try { return parseJson(line, recordLine, `record ${at + 1}`); } catch (cause) { throw new Error(`${file} line ${at + 1} is not a System Store record`, { cause }); }
  });
  const lease = yield* integration(() => acquireLocalDataOwnership(directory, "maintenance"));
  yield* Effect.acquireUseRelease(
    Effect.sync(() => createLocalSqliteSystemStore({ filename: join(directory, "system", "zelavis.sqlite") })),
    (store) => Effect.gen(function* () {
      const held = yield* integration(() => Promise.resolve(store.namespaces()));
      if (held.length > 0 && !replace) {
        return yield* new SystemStoreImportRefused({ message: `The System Store at ${directory} holds ${held.length} namespaces; repeat with --replace to replace them with the backup's.` });
      }
      for (const namespace of held) {
        for (const record of yield* integration(() => Promise.resolve(store.list(namespace.namespace)))) yield* integration(() => Promise.resolve(store.delete(record.namespace, record.key)));
      }
      for (const record of records) yield* integration(() => Promise.resolve(store.set(record.namespace, record.key, record.value as never)));
      console.log(`Imported ${records.length} System Store records into ${directory}.`);
    }),
    (store) => Effect.sync(() => { store.close?.(); }),
  ).pipe(Effect.ensuring(Effect.orDie(integration(() => lease.release()))));
});

const run = Effect.fn("cli.systemStore")(function* (args: readonly string[]) {
  if (args[0] === "import") return yield* importRecords(args.slice(1));
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
