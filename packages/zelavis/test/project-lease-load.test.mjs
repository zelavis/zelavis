import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createWriterLeaseRoutes } from "../dist/platform/writer-lease-routes.js";
import { systemStoreLeaseAudit, systemStoreLeaseStore } from "../dist/platform/writer-lease-store.js";

const PROJECTS = 200;
const ROUNDS = 10;

// What a lease renewal costs the Platform: the route handler plus one System Store read and compare-and-set. HTTP framing
// is the same for every route and measures the test machine, so the routes are called directly. The measurement is the
// basis for the 30 s default of ZELAVIS_PROJECT_LEASES_TTL_MILLIS.
test("a writer lease renewal costs the Platform a fraction of a millisecond", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-lease-load-"));
  const store = createLocalSqliteSystemStore({ filename: join(directory, "zelavis.sqlite") });
  try {
    const routes = createWriterLeaseRoutes(systemStoreLeaseStore(store), systemStoreLeaseAudit(store));
    const read = routes.find((route) => route.id === "runtime.writerLeases.read");
    const write = routes.find((route) => route.id === "runtime.writerLeases.write");
    const principal = { id: "owner", type: "user", permissions: ["*"] };
    for (let index = 0; index < PROJECTS; index += 1) {
      const partition = `project-${index}`;
      const created = await write.handler({ params: { partition }, body: { lease: { partition, owner: "node-a", epoch: 1, expiresAt: Date.now() + 30_000, acknowledgedHead: 0 } }, principal });
      assert.equal(created.status, 201);
    }
    let elapsed = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      for (let index = 0; index < PROJECTS; index += 1) {
        const partition = `project-${index}`;
        const started = performance.now();
        const current = await read.handler({ params: { partition }, principal });
        const renewed = await write.handler({
          params: { partition }, principal,
          body: { lease: { ...current.body.lease, expiresAt: current.body.lease.expiresAt + 10_000 }, expectedVersion: current.body.version },
        });
        elapsed += performance.now() - started;
        assert.equal(renewed.status ?? 200, 200);
      }
    }
    const average = elapsed / (PROJECTS * ROUNDS);
    console.log(`renewal: ${average.toFixed(3)} ms`);
    assert.ok(average < 5, `a renewal averaged ${average.toFixed(3)} ms`);
  } finally {
    await store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
