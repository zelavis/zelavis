import { Effect } from "effect";
import { integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createZelavisClient, type ZelavisLogEntry, type ZelavisLogQuery } from "../sdk/fetch.js";

const usage =
  "zelavis logs [--ref REFERENCE] [--level debug|info|warn|error] [--source NAME] [--limit N] [--after SEQUENCE] [--follow] [--url URL] [--token TOKEN] [--json]";

/**
 * `zelavis logs` reads the Platform's recent log through the JS SDK client.
 * `--ref` takes the reference shown with an "Action failed" message and prints
 * the cause behind it; `--follow` keeps reading what is written next.
 */
const runLogsCommandProgram = Effect.fn("LogsCLI.run")(function* (args: readonly string[]): Effect.fn.Return<void, TaggedFailure> {
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false, follow = false;
  const query: { -readonly [K in keyof ZelavisLogQuery]: ZelavisLogQuery[K] } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--follow" || arg === "-f") { follow = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--ref", "--level", "--source", "--limit", "--after"].includes(flag)) {
      return yield* new IntegrationFailure(new Error(`Unknown logs option "${arg}". ${usage}`));
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) return yield* new IntegrationFailure(new Error(`${flag} requires a value.`));
    if (flag === "--url") url = value;
    else if (flag === "--token") token = value;
    else if (flag === "--ref") query.correlationId = value;
    else if (flag === "--level") query.level = value as ZelavisLogEntry["level"];
    else if (flag === "--source") query.source = value;
    else if (flag === "--limit") query.limit = Number(value);
    else query.after = Number(value);
  }

  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const show = (entry: ZelavisLogEntry) => {
    console.log(json ? JSON.stringify(entry) : `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.source}${entry.correlationId ? ` [${entry.correlationId}]` : ""} ${entry.message}`);
    if (!json && entry.detail) console.log(entry.detail.split("\n").map((line) => `    ${line}`).join("\n"));
  };

  let page = yield* integration(() => client.logs.read(query));
  if (page.truncated && !json) console.log("(older entries were dropped from the log)");
  for (const entry of page.entries) show(entry);
  if (!follow) return;
  let after = page.latest;
  for (;;) {
    yield* Effect.sleep(2000);
    const next = yield* Effect.result(integration(() => client.logs.read({ ...query, after })));
    if (next._tag === "Failure") continue;
    page = next.success;
    for (const entry of page.entries) show(entry);
    after = Math.max(after, page.latest);
  }
});

export function runLogsCommand(args: readonly string[]): Promise<void> { return present(runLogsCommandProgram(args)); }
