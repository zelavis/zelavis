// The Platform of the shard drill: a real Platform and a real @zelavis/app Project in this container, with its shard on the
// Agent in another one. It reports each step as a JSON line. The first USR1 signals the primary's network cut,
// the second starts the replica phase after the release check, HUP signals the replica's cut, USR2 signals either heal,
// and TERM stops the drill. Between the heal and the release, /shared/stall says the Agent has been made silent (its
// connections stay open and nothing answers: no reset, only time) and /shared/stall-over that it answers again.
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { Zelavis } from "/repo/packages/zelavis/dist/index.js";
import { nodeAdapter } from "/repo/packages/zelavis/dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "/repo/packages/zelavis/dist/adapters/_sqlite-system-store.js";
import { createZelavisClient } from "/repo/packages/zelavis/dist/sdk/fetch.js";
import { virtualRangeFor } from "/repo/packages/zelavis/dist/db/topology.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const emit = (event, extra = {}) => console.log(JSON.stringify({ event, at: Date.now(), ...extra }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, accept, what, deadline = 90_000) => {
  const end = Date.now() + deadline;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(150);
  }
};

let zv;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const answer = await zv.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, {
    method: request.method, headers: request.headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  }));
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ZELAVIS_APP_SHARDS_URL = `http://127.0.0.1:${server.address().port}/zelavis/api/v1`;

zv = new Zelavis({ adapter: nodeAdapter({
  dataDirectory: "/data/platform",
  projects: { remoteDispatch: { localNodeId: "node-a", nodes: { "node-b": { url: process.env.ZELAVIS_DRILL_AGENT_URL ?? "https://agent:8443", agentId: "agent-b", caFile: "/certs/tls.crt" } } } },
}) });
const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), OWNER) });
const call = async (method, path, body) => {
  const answer = await zv.fetch(new Request(`http://127.0.0.1/zelavis/api/v1/runtime${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), OWNER);
  return { status: answer.status, body: await answer.json().catch(() => undefined) };
};
await call("GET", "/config");
const store = createLocalSqliteSystemStore({ filename: "/data/platform/system/zelavis.sqlite" });
writeFileSync("/shared/trust.json", JSON.stringify((await store.get("fabric.agent-trust.v1", "platform")).value));
emit("platform-ready");

const created = await call("POST", "/projects", { id: "drill", name: "drill", recipeName: "@zelavis/app", start: true });
if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created)}`);
await until(async () => (await call("GET", "/projects/drill")).body?.project, (project) => project?.runtime?.status === "running", "the Project to run");
await client.shardPlacement.setAllocation("drill", { allowedNodeIds: ["node-b"], cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskBytes: 64 * 2 ** 30, expectedGeneration: 0 });

const data = client.data("drill");
await data.collections.create({ name: "notes" });
const acked = [];
const insert = async (id) => { await data.documents.insert("notes", { id, data: { n: id } }); acked.push(id); };
for (let index = 0; index < 100; index += 1) await insert(`d${index}`);
const tenants = await client.projects.tenants("drill");
const caller = tenants.find((entry) => entry.documents >= 100).tenantId;
const callerRange = virtualRangeFor({ virtualRanges: 256 }, caller);
const local = ["l1", "l2", "l3", "l4"].find((id) => virtualRangeFor({ virtualRanges: 256 }, id) !== callerRange);
await client.shards("drill").place({ virtualRanges: [callerRange], resources: { cpuCores: 1, memoryBytes: 256 * 2 ** 20, diskBytes: 512 * 2 ** 20 } });
const placed = await until(() => client.shards("drill").operation(), (operation) => operation?.phase === "done" || operation?.phase === "failed", "place");
if (placed.phase !== "done") throw new Error(`place failed: ${placed.error}`);
await insert("after-place");
emit("placed", { acked: acked.length });
const placedMissing = [];
for (const id of acked) if ((await data.documents.get("notes", id))?.id !== id) placedMissing.push(id);
emit("read-placed", { acked: acked.length, missing: placedMissing });

let primarySignals = 0, healed = false, replicaCut = false, finish = false;
process.on("SIGUSR1", () => { primarySignals += 1; });
process.on("SIGUSR2", () => { healed = true; });
process.on("SIGHUP", () => { replicaCut = true; });
process.on("SIGTERM", () => { finish = true; });

await until(() => primarySignals >= 1, Boolean, "the partition", 120_000);
let refused = false;
try { await insert("during-partition"); } catch { refused = true; }
let readError;
try { await data.documents.get("notes", acked[0]); } catch (error) { readError = error; }
await client.projects.createTenant("drill", { tenantId: local, table: "t" });
emit("partition-checked", { refused, readRefused: readError !== undefined, localWriteOk: true });

await until(() => healed, Boolean, "the network to return", 120_000);
await until(async () => { try { await insert(`healed${acked.length}`); return true; } catch { return false; } }, Boolean, "a write after the network returned", 120_000);
const missing = [];
for (const id of acked) if ((await data.documents.get("notes", id).catch(() => undefined))?.id !== id) missing.push(id);
emit("healed", { acked: acked.length, missing });

// A silent Agent: a write must be refused within the remote engine's own bounds rather than hang, and a local Tenant keeps
// taking writes meanwhile. Nothing acknowledged before or after may be lost.
await until(() => existsSync("/shared/stall"), Boolean, "the stall", 120_000);
const stallStarted = Date.now();
let stallRefused = false, stallError;
try { await insert("during-stall"); } catch (error) { stallRefused = true; stallError = String(error?.message ?? error).slice(0, 400); }
const stallMillis = Date.now() - stallStarted;
// What the Project did meanwhile: how many engine calls waited out their timeout, and why the write was refused.
const stallLog = (await client.projects.logs("drill")).filter((entry) => Date.parse(entry.timestamp) >= stallStarted).map((entry) => `${entry.timestamp} ${entry.message.slice(0, 300)}`).slice(-40);
const localDuringStall = await call("POST", "/projects/drill/proxy/zelavis/api/v1/database/documents/t", { tenantId: local, id: "during-stall", data: { n: 1 } });
emit("stall-checked", { refused: stallRefused, millis: stallMillis, error: stallError, log: stallLog, localWriteOk: localDuringStall.status < 300 });
await until(() => existsSync("/shared/stall-over"), Boolean, "the end of the stall", 120_000);
await until(async () => { try { await insert(`after-stall${acked.length}`); return true; } catch { return false; } }, Boolean, "a write after the stall", 180_000);
const missingAfterStall = [];
for (const id of acked) if ((await data.documents.get("notes", id).catch(() => undefined))?.id !== id) missingAfterStall.push(id);
emit("stall-healed", { acked: acked.length, missing: missingAfterStall });

const shard = (await client.shards("drill").list()).shards.find((each) => each.location === "remote");
await client.shards("drill").release(shard.shardId, { into: "shard-0" });
const released = await until(() => client.shards("drill").operation(), (operation) => operation?.phase === "done" || operation?.phase === "failed", "release");
const afterRelease = [];
for (const id of acked) if ((await data.documents.get("notes", id).catch(() => undefined))?.id !== id) afterRelease.push(id);
emit("released", { phase: released.phase, missing: afterRelease });
await until(() => primarySignals >= 2, Boolean, "the release check", 120_000);
const shards = client.shards("drill");
const localShard = (await client.projects.tenants("drill")).find((entry) => entry.tenantId === local).shard;
const replica = async () => (await shards.list()).shards.find((each) => each.shardId === localShard)?.replica;
const terminal = (operation) => operation?.phase === "done" || operation?.phase === "failed";
await shards.replicate(localShard, { diskBytes: 512 * 2 ** 20 });
const replicated = await until(() => shards.operation(), terminal, "replicate");
if (replicated.phase !== "done") throw new Error(`replicate failed: ${replicated.error}`);
await until(replica, (copy) => copy?.status === "following", "initial replica catch-up");
healed = false;
emit("replicated");
await until(() => replicaCut, Boolean, "the replica partition", 120_000);
for (let index = 0; index < 20; index++) {
  const written = await call("POST", "/projects/drill/proxy/zelavis/api/v1/database/documents/t", {
    tenantId: local, id: `while-cut-${index}`, data: { n: index },
  });
  if (written.status >= 300) throw new Error(`write during replica outage: ${JSON.stringify(written)}`);
}
const lastWrite = Date.now();
emit("replica-cut", { ok: true });
await until(() => healed, Boolean, "the replica network to return", 120_000);
const current = await until(replica, (copy) => copy?.status === "following" && Date.parse(copy.heldAsOf) > lastWrite, "replica catch-up");
emit("replica-healed", { heldAsOf: current.heldAsOf, lastWrite });
await shards.unreplicate(localShard);
const unreplicated = await until(() => shards.operation(), terminal, "unreplicate");
emit("unreplicated", { phase: unreplicated.phase });
await until(() => finish, Boolean, "stop", 600_000);
await zv.close();
process.exit(0);
