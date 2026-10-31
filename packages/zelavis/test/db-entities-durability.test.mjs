// Durable entities across real crashes: a process serving them is killed with SIGKILL again and again — no chance
// to close anything — at random moments, and started again on the same files. At-least-once delivery means a
// handler may run more than once for a message; the database must still hold exactly one effect per message, because
// a step's writes commit only with the message's processed mark.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { temporaryDatabaseDirectory } from "./_database.mjs";
import { openNodeDatabase } from "../dist/db/node-host.js";

const worker = new URL("./fixtures/entity-worker.mjs", import.meta.url).pathname;
const MESSAGES = 240;

test("killed again and again while serving, every message's effects land exactly once", { timeout: 300_000 }, async (t) => {
  const directory = temporaryDatabaseDirectory(t);
  const setup = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"], crossTenantRefresh: false });
  for (const tenant of ["acme", "globex"]) {
    await setup.api.forTenant(tenant).documents.createCollection({ name: "counters" });
    await setup.api.forTenant(tenant).documents.createCollection({ name: "effects" });
  }
  for (let n = 0; n < MESSAGES; n++) {
    const sent = await setup.api.forTenant(n % 2 === 0 ? "acme" : "globex").entities.send({
      type: "counter", id: ["a", "b", "c", "d"][n % 4], tag: "add", payload: { n }, primaryKey: `m-${n}`,
    });
    assert.equal(sent.duplicate, false);
  }
  await setup.close();

  let kills = 0;
  for (let round = 0; ; round++) {
    assert.ok(round < 200, "the work finishes");
    const child = spawn(process.execPath, [worker, directory], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    // Most rounds die mid-work; every fifth runs to the end if it can.
    if (round % 5 !== 4) {
      while (!output.includes("serving")) await Promise.race([once(child.stdout, "data"), exited]);
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 120)));
      if (child.exitCode === null) { child.kill("SIGKILL"); kills += 1; }
    }
    const [code] = await exited;
    if (code === 0 && output.includes("done")) break;
  }
  assert.ok(kills >= 3, `the worker was killed mid-work (${kills} times)`);

  const opened = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"], crossTenantRefresh: false });
  t.after(() => opened.close());
  let counted = 0;
  let effects = 0;
  let processed = 0;
  for (const tenant of ["acme", "globex"]) {
    const api = opened.api.forTenant(tenant);
    for (const id of ["a", "b", "c", "d"]) {
      counted += (await api.documents.findById({ collection: "counters", id }))?.data.count ?? 0;
      // Even messages go to acme's a and c, odd ones to globex's b and d.
      const state = await api.entities.state({ type: "counter", id });
      if (state === undefined) continue;
      assert.equal(state.pending, 0);
      assert.equal(state.failed, 0);
      processed += state.processed;
    }
    effects += await api.documents.count("effects");
  }
  assert.equal(processed, MESSAGES, "every message processed once");
  assert.equal(counted, MESSAGES, "every counter raised once per message, never twice");
  assert.equal(effects, MESSAGES, "one effect document per message");
  for (let n = 0; n < MESSAGES; n += 37) {
    const message = await opened.api.forTenant(n % 2 === 0 ? "acme" : "globex").entities.message({ type: "counter", id: ["a", "b", "c", "d"][n % 4], messageKey: `m-${n}` });
    assert.equal(message.status, "processed");
  }
});
