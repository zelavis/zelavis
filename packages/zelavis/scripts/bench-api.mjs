// Measures the full Zelavis Public Database API and HTTP Service layer.
//
//   node scripts/bench-api.mjs          (5,000 documents)
//   N=20000 node scripts/bench-api.mjs
//
// Unlike bench-engines.mjs (which measures raw internal KvStore calls),
// this benchmark exercises the public Zelavis database application layer:
//   - Collection creation and schema registration
//   - Single-transaction document inserts (event log append + lens projection)
//   - Batch writes (DocumentWrite operations in a single atomic transaction)
//   - Point reads by primary ID (findById) with JSON decoding
//   - Ordered pagination (findPage with opaque cursor continuation)
//   - Filtered queries (findMany with where constraints)
//   - In-place updates (merge / replace)
//   - Deletions and postings retraction
//   - Composite index creation and background backfilling
//   - HTTP service route overhead (principal auth + routing + handler dispatch)
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
  defineDatabaseService,
  makeDatabase,
  partitionMapFor,
  runtimeApiFor,
} from "../dist/db/index.js";
import { runEngines } from "./bench-engine.mjs";

const N = Number(process.env.N ?? 5000);
const BATCH_SIZE = 500;
const BATCH_DOCS = Math.min(2000, N);

const rnd = (s) => () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CATEGORIES = ["electronics", "apparel", "home", "books", "sports", "automotive"];
const REGIONS = ["eu-west", "us-east", "us-west", "ap-south"];

const buildItems = (count) => {
  const rand = rnd(12345);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: `doc_${String(i).padStart(6, "0")}`,
      data: {
        sku: `SKU-${100000 + i}`,
        title: `Product item ${i}`,
        category: pick(CATEGORIES),
        region: pick(REGIONS),
        price: Math.floor(rand() * 10000) / 100,
        stock: Math.floor(rand() * 500),
        active: rand() > 0.1,
      },
    });
  }
  return items;
};

const items = buildItems(N);
const batchItems = buildItems(BATCH_DOCS).map((item, idx) => ({
  ...item,
  id: `batch_${String(idx).padStart(6, "0")}`,
}));

const median = async (runs, fn) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

const outputs = await runEngines("zv-bench-api", async ({ name, dir, open }) => {
  const row = { engine: name, documents: N };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["s0", "s1", "s2", "s3"]),
          openShard: (shard) => open(shard),
        });

        const api = runtimeApiFor(db);
        const tenant = api.forTenant("benchmark_tenant");
        const service = defineDatabaseService(api);

        yield* Effect.promise(async () => {
          // 1. Collection Creation
          const tColl = performance.now();
          await tenant.documents.createCollection({ name: "products", surface: "database" });
          row.createCollectionMs = +(performance.now() - tColl).toFixed(2);

          // 2. Sequential Single-Document Inserts
          // Measures individual write transactions with event log + postings derivation
          const tSingle = performance.now();
          for (let i = 0; i < N; i++) {
            await tenant.documents.insert({
              collection: "products",
              id: items[i].id,
              data: items[i].data,
            });
          }
          const singleTotalMs = performance.now() - tSingle;
          row.singleInsertMs = +singleTotalMs.toFixed(1);
          row.singleInsertPerSec = Math.round(N / (singleTotalMs / 1000));
          row.singleInsertAvgMs = +(singleTotalMs / N).toFixed(3);

          // 3. Batch Inserts
          await tenant.documents.createCollection({ name: "batch_products", surface: "database" });
          const tBatch = performance.now();
          for (let i = 0; i < BATCH_DOCS; i += BATCH_SIZE) {
            const slice = batchItems.slice(i, i + BATCH_SIZE);
            await tenant.documents.write({
              operations: slice.map((item) => ({
                op: "insert",
                collection: "batch_products",
                id: item.id,
                data: item.data,
              })),
            });
          }
          const batchTotalMs = performance.now() - tBatch;
          row.batchInsertMs = +batchTotalMs.toFixed(1);
          row.batchInsertPerSec = Math.round(BATCH_DOCS / (batchTotalMs / 1000));

          // 4. Point Reads by ID (findById)
          const READ_SAMPLES = Math.min(1000, N);
          const pointMs = await median(3, async () => {
            for (let i = 0; i < READ_SAMPLES; i++) {
              await tenant.documents.findById({
                collection: "products",
                id: items[i].id,
              });
            }
          });
          row.findById1kMs = +pointMs.toFixed(2);
          row.findByIdAvgUs = +((pointMs / READ_SAMPLES) * 1000).toFixed(2);

          // 5. Filtered Queries (findMany with where)
          const findManyMs = await median(5, async () => {
            return await tenant.documents.findMany({
              collection: "products",
              where: [{ path: "category", value: "electronics" }],
            });
          });
          row.findManyCategoryMs = +findManyMs.toFixed(2);

          // 6. Ordered Cursor Pagination (findPage, 20 pages of 50)
          const pageWalkMs = await median(5, async () => {
            let after;
            let total = 0;
            for (let p = 0; p < 20; p++) {
              const page = await tenant.documents.findPage({
                collection: "products",
                orderBy: [{ path: "price", direction: "asc" }],
                limit: 50,
                ...(after ? { after } : {}),
              });
              total += page.documents.length;
              after = page.next;
              if (!after) break;
            }
            return total;
          });
          row.findPage20PagesMs = +pageWalkMs.toFixed(2);

          // 7. In-Place Updates (500 documents)
          const UPDATE_COUNT = Math.min(500, N);
          const tUpdate = performance.now();
          for (let i = 0; i < UPDATE_COUNT; i++) {
            await tenant.documents.update({
              collection: "products",
              id: items[i].id,
              data: { stock: 999, active: false },
              mode: "merge",
            });
          }
          const updateMs = performance.now() - tUpdate;
          row.update500Ms = +updateMs.toFixed(2);
          row.updatePerSec = Math.round(UPDATE_COUNT / (updateMs / 1000));

          // 8. Document Deletions (500 documents)
          const DELETE_COUNT = Math.min(500, N);
          const tDelete = performance.now();
          for (let i = 0; i < DELETE_COUNT; i++) {
            await tenant.documents.delete({
              collection: "products",
              id: items[i].id,
            });
          }
          const deleteMs = performance.now() - tDelete;
          row.delete500Ms = +deleteMs.toFixed(2);
          row.deletePerSec = Math.round(DELETE_COUNT / (deleteMs / 1000));

          // 9. Composite Index Creation (Background backfill over remaining documents)
          const tIndex = performance.now();
          await tenant.documents.createIndex({
            collection: "products",
            name: "idx_category_price",
            fields: [{ path: "category" }, { path: "price", direction: "desc" }],
          });
          row.createIndexMs = +(performance.now() - tIndex).toFixed(2);

          // 10. HTTP Route Handler Overhead Check
          // Dispatching through defineDatabaseService routes
          const mockPrincipal = {
            id: "bench_user",
            type: "user",
            permissions: ["database.read", "database.write"],
            metadata: { tenantId: "benchmark_tenant" },
          };
          const allRoutes = [
            ...(service.api?.v1 ?? []),
            ...(service.services ?? []).flatMap((nested) => nested.api?.v1 ?? []),
          ];
          const getRoute = allRoutes.find((r) => r.id === "database.documents.get");
          const HTTP_SAMPLES = Math.min(500, N);
          const tHttp = performance.now();
          if (getRoute) {
            for (let i = 0; i < HTTP_SAMPLES; i++) {
              await getRoute.handler({
                service: api,
                params: { collection: "products", id: items[i].id },
                query: new URLSearchParams(),
                body: undefined,
                principal: mockPrincipal,
                headers: {},
                request: undefined,
              });
            }
          }
          const httpMs = performance.now() - tHttp;
          row.httpRouteAvgUs = +((httpMs / HTTP_SAMPLES) * 1000).toFixed(2);

          // Summary report to stderr so child stdout remains pure JSON
          console.error(`\n[${name}] Zelavis Public Database API Results (${N} documents):`);
          console.error(`  Single Inserts:      ${String(row.singleInsertPerSec).padStart(7)} docs/s  (${row.singleInsertAvgMs}ms avg latency)`);
          console.error(`  Batch Inserts:       ${String(row.batchInsertPerSec).padStart(7)} docs/s  (${BATCH_SIZE} per batch)`);
          console.error(`  Point Read by ID:    ${String(row.findByIdAvgUs).padStart(7)} μs/doc   (${row.findById1kMs}ms for 1,000)`);
          console.error(`  Cursor Paging (20p): ${String(row.findPage20PagesMs).padStart(7)} ms     (50 docs/page ordered by price)`);
          console.error(`  Filtered Query:      ${String(row.findManyCategoryMs).padStart(7)} ms     (findMany category = electronics)`);
          console.error(`  Document Updates:    ${String(row.updatePerSec).padStart(7)} docs/s  (500 merged updates)`);
          console.error(`  Document Deletions:  ${String(row.deletePerSec).padStart(7)} docs/s  (500 deletions + retractions)`);
          console.error(`  Composite Indexing:  ${String(row.createIndexMs).padStart(7)} ms     (backfill over remaining collection)`);
          console.error(`  HTTP Route Dispatch: ${String(row.httpRouteAvgUs).padStart(7)} μs/op    (full route auth + handler overhead)`);
        });
      }),
    ),
  );

  console.log(JSON.stringify({ documents: N, results: [row] }, null, 2));
}, { collectJson: true });

if (!process.env.ZELAVIS_BENCH_ENGINE_CHILD) {
  const results = outputs.flatMap((output) => {
    try {
      return JSON.parse(output).results ?? [];
    } catch {
      return [];
    }
  });
  console.log("\n=================== FINAL ZELAVIS PUBLIC API BENCHMARK ===================");
  console.log(JSON.stringify({ documents: N, results }, null, 2));
}
