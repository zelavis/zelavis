// A controlled memory measurement of the SQLite read path: the resident memory a read can add is a
// function of its budget, not of the data behind it. Each read runs in a process of its own so that
// the peak it reports is that read's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/documents.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const run = promisify(execFile);
const MiB = 1024 * 1024;

test("a read adds memory in proportion to its budget, not to the data it would have read", { timeout: 300_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-read-memory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // 80 documents of 1 MiB: about 160 MiB on disk once the log holds each too, 80 MiB to read.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writer = yield* openShardOverKv("s", yield* makeNodeSqliteEngine("s", directory));
    const docs = documentsFor(writer.partition("t"), "t");
    yield* docs.createCollection({ name: "notes", columns: ["title"] });
    for (let n = 0; n < 80; n++) yield* docs.insert({ collection: "notes", id: `n${n}`, data: { title: `note ${n}`, body: String.fromCharCode(97 + (n % 26)).repeat(MiB) } });
  })));
  const measure = async (mode, bytes = 0) => {
    const { stdout } = await run(process.execPath, ["--expose-gc", new URL("./_read-budget-memory-child.mjs", import.meta.url).pathname, directory, mode, String(bytes)], { maxBuffer: 16 * MiB });
    return JSON.parse(stdout);
  };
  const control = await measure("unbounded");
  assert.equal(control.documents, 80);
  assert.ok(control.growthMiB > 150, `without a budget the read holds what it reads (grew ${control.growthMiB.toFixed(0)} MiB)`);
  const bounded = await measure("bounded", 8 * MiB);
  t.diagnostic(`control grew ${control.growthMiB.toFixed(0)} MiB; an 8 MiB budget grew ${bounded.growthMiB.toFixed(0)} MiB (spent ${JSON.stringify(bounded.spent)})`);
  assert.equal(bounded.refused, "bytes");
  assert.ok(bounded.spent.bytes <= 8 * MiB);
  // Eight MiB of budget: the value copied, its text, and the parsed copy are the most that is ever held,
  // so a few times the budget with room for the allocator, and far below the control.
  assert.ok(bounded.growthMiB < 8 * 4 + 24, `an 8 MiB budget grew resident memory by ${bounded.growthMiB.toFixed(0)} MiB`);
  assert.ok(bounded.growthMiB < control.growthMiB / 2);
});
