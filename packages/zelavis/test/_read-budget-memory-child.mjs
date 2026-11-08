// Runs one read over an existing shard in a process of its own and reports how far its resident memory grew.
import { Effect } from "effect";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { openShardReaderOverKv } from "../dist/db/kv-store.js";
import { ReadBudgetExceeded } from "../dist/db/errors.js";
import { makeReadBudget } from "../dist/db/read-budget.js";
import { GLOBAL_TENANT } from "../dist/db/topology.js";
import { tenantReadsOver, runTenantRead } from "../dist/db/tenant-reads.js";

const [directory, mode, bytes] = process.argv.slice(2);
const peakMiB = () => process.resourceUsage().maxRSS / 1024;
const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const engine = yield* makeNodeSqliteEngine("s", directory);
  const budget = mode === "bounded" ? makeReadBudget({ bytes: Number(bytes) }) : undefined;
  const reader = yield* openShardReaderOverKv("s", engine, budget === undefined ? undefined : { budget });
  const api = tenantReadsOver(reader.partition("t"), reader.partition(GLOBAL_TENANT), "t");
  if (global.gc) global.gc();
  const baseline = peakMiB();
  const exit = yield* Effect.exit(runTenantRead(api, "documents.findMany", { collection: "notes" }));
  const defect = exit._tag === "Failure" ? exit.cause.reasons[0]?.defect : undefined;
  return {
    growthMiB: peakMiB() - baseline,
    refused: defect instanceof ReadBudgetExceeded ? defect.limit : null,
    documents: exit._tag === "Success" ? exit.value.length : 0,
    spent: budget?.used(),
  };
})));
console.log(JSON.stringify(outcome));
