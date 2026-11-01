// One database node of the failover drill, in its own container: a Zelavis database with the leader transport served
// over HTTP, a writer (holds the lease and writes) or a standby (follows, and takes over when the lease lapses).
// It prints one JSON line per event; the orchestrator reads them with `docker logs`. Not shipped.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Effect, Exit, Fiber, Scope } from "effect";
import { openNodeDatabase } from "/repo/packages/zelavis/dist/db/node-host.js";
import {
  defineDatabaseService, httpLeaseStore, remoteAcknowledgments, remoteDatabaseLeader, remoteLeader, writeAcknowledged,
} from "/repo/packages/zelavis/dist/db/index.js";
import { createZelavisClient } from "/repo/packages/zelavis/dist/sdk/fetch.js";

const env = (name, fallback) => process.env[name] ?? fallback;
const NAME = env("NAME", "node");
const ROLE = env("ROLE", "writer");
const ENDPOINT = env("ENDPOINT", `http://${NAME}:8080`);
const AUTHORITY = env("AUTHORITY", "http://authority:8080");
const TOKEN = env("TOKEN", "drill-token");
const TTL = Number(env("TTL_MILLIS", "3000"));
const PARTITION = "acme";
// MODE=partition: the lease guards one partition. MODE=database: it guards the whole database, many Tenants, the Project.
const MODE = env("MODE", "partition");
const TENANTS = MODE === "database" ? Number(env("TENANTS", "100")) : 1;
const SCOPE = "project-1";
const tenantOf = (n) => (MODE === "database" ? `tenant-${n % TENANTS}` : PARTITION);
const allTenants = () => (MODE === "database" ? Array.from({ length: TENANTS }, (_, at) => `tenant-${at}`) : [PARTITION]);
const say = (event, extra = {}) => console.log(JSON.stringify({ event, node: NAME, at: Date.now(), ...extra }));

mkdirSync("/data/shards", { recursive: true });
const leases = httpLeaseStore({ apiRoot: `${AUTHORITY}/zelavis/api/v1`, token: TOKEN, timeoutMillis: 1000 });
// ROLE=start: this container is started as the Project, the way a node is told to start one. The database takes the
// whole-database lease before it opens, or does not open at all.
const startLease = ROLE === "start" ? {
  leases, scope: SCOPE, owner: NAME, ttlMillis: TTL, endpoint: ENDPOINT, standby: env("STANDBY", "none"),
  onSuperseded: () => { say("superseded"); process.exit(75); },
} : undefined;
let opened;
try {
  opened = await openNodeDatabase({ directory: "/data/shards", crossTenantRefresh: false, ...(startLease === undefined ? {} : { lease: startLease }) });
} catch (error) {
  const chain = [error, error?.cause, error?.cause?.cause].map((entry) => entry?._tag ?? entry?.message ?? "").filter(Boolean).join(" < ");
  say("start-refused", { why: chain || String(error) });
  process.exit(3);
}
const { database, api } = opened;

// ---- the leader transport, served for the peer's follower ----
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";
const followerRoutes = defineDatabaseService(api).api.v1.filter((route) => route.id.startsWith("database.followers."));
createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const url = new URL(request.url, "http://node");
  if (!url.pathname.startsWith(PROXY)) return send(404, { error: "not a database route" });
  const segments = url.pathname.slice(PROXY.length).split("/").filter(Boolean);
  for (const route of followerRoutes) {
    const pattern = route.path.split("/").filter(Boolean);
    if (route.method !== request.method || pattern.length !== segments.length) continue;
    const params = {};
    if (!pattern.every((part, at) => part.startsWith(":") ? ((params[part.slice(1)] = decodeURIComponent(segments[at])), true) : part === segments[at])) continue;
    const answer = await route.handler({ service: api, params, query: url.searchParams, body: text === "" ? undefined : JSON.parse(text), principal: { id: "peer", kind: "service", permissions: ["*"] }, headers: {}, request: undefined });
    return send(answer.status ?? 200, answer.body);
  }
  return send(404, { error: "no follower route" });
}).listen(8080);

// Where the writer is comes from its lease (`endpoint`), never from configuration: after a promotion the lease names the new one.
const leaderFor = (endpoint) => {
  const transport = createZelavisClient({ baseUrl: endpoint, rootPath: "/zelavis" }).followers("p1");
  if (MODE === "database") return remoteDatabaseLeader(transport);
  return { source: remoteLeader(transport, PARTITION), acknowledgments: { name: NAME, to: remoteAcknowledgments(transport, PARTITION) } };
};
const inScope = (scope, effect) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)));
/** Every document the node holds as [id, author], in write order, across the Tenants of its mode. */
const docsNow = async () => {
  const out = [];
  for (const tenant of allTenants()) {
    const found = await api.forTenant(tenant).documents.findMany({ collection: "posts" }).catch(() => []);
    for (const doc of found) out.push([doc.id, doc.data.by]);
  }
  return out.sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
};
const idsNow = async () => (await docsNow()).map(([id]) => id);
const headNow = async () => (MODE === "database" ? (await idsNow()).length
  : (await Effect.runPromise(Effect.flatMap(database.followers.source(PARTITION), (source) => source.stats))).head);

/** Follow whoever holds the lease, however many Tenants there are. */
const follow = () => (MODE === "database"
  ? database.writerLeases.followDatabase({ scope: SCOPE, leases, owner: NAME, leaderFor, timeoutMillis: 500, pollMillis: 300 })
  : database.writerLeases.follow({ partition: PARTITION, leases, owner: NAME, leaderFor, interval: "100 millis", pollMillis: 300 }));

// ---- writing ----
let writing = false;
const writeLoop = async (handle, start) => {
  writing = true;
  for (let n = start; writing; n++) {
    const id = `p${n}`;
    const tenant = tenantOf(n);
    const source = await Effect.runPromise(database.followers.source(tenant));
    const acknowledgments = await Effect.runPromise(database.followers.acknowledgments(tenant));
    const insert = database.forTenant(tenant).documents.insert({ collection: "posts", id, data: { n, by: NAME } });
    // With a follower reporting, a write is acknowledged once the follower holds it: that is the promise a failover keeps.
    const exit = await Effect.runPromiseExit(writeAcknowledged(source, acknowledgments, insert, { followers: 1, timeout: "1500 millis" }));
    // When the write actually committed: the document's own creation time, not when this line is printed.
    const committedAt = async () => Date.parse((await api.forTenant(tenant).documents.findById({ collection: "posts", id }))?.createdAt ?? "");
    if (Exit.isSuccess(exit)) say("acked", { id, position: exit.value.position, committedAt: await committedAt() });
    else {
      const error = exit.cause.reasons.map((reason) => reason.error ?? reason.defect).find((value) => value !== undefined);
      if (error?._tag === "FollowersNotAcknowledged") say("committed", { id, committedAt: await committedAt() });
      else say("refused", { id, why: error?._tag ?? String(error?.message ?? error).slice(0, 120) });
    }
    if (!(await Effect.runPromise(handle.writable))) { say("fenced", { epoch: (await Effect.runPromise(handle.lease)).epoch }); writing = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
};

const final = async () => {
  const docs = await docsNow();
  say("final", { ids: docs.map(([id]) => id), by: Object.fromEntries(docs), head: await headNow() });
  process.exit(0);
};
process.on("SIGTERM", () => { writing = false; final(); });
// SIGUSR2: stop writing and keep serving, so a follower can level out before the drill compares the two.
process.on("SIGUSR2", () => { writing = false; say("quiesced"); });

if (ROLE === "writer") {
  for (const tenant of allTenants()) await api.forTenant(tenant).documents.createCollection({ name: "posts" });
  const scope = Effect.runSync(Scope.make());
  const standby = env("STANDBY", "") === "" ? {} : { standby: env("STANDBY", "") };
  const handle = await inScope(scope, MODE === "database"
    ? database.writerLeases.holdDatabase({ scope: SCOPE, leases, owner: NAME, ttlMillis: TTL, endpoint: ENDPOINT, standby: env("STANDBY", "") })
    : database.writerLeases.hold({ partition: PARTITION, leases, owner: NAME, ttlMillis: TTL, endpoint: ENDPOINT, ...standby }));
  say("writer", { epoch: (await Effect.runPromise(handle.lease)).epoch });
  await writeLoop(handle, 1);
  // Superseded: stop being a writer and follow whoever the lease names now. What this node wrote past what was
  // acknowledged is copied over by the follow.
  await Effect.runPromise(Scope.close(scope, Exit.void));
  say("following");
  await Effect.runPromise(follow());
} else if (ROLE === "start") {
  const held = (await Effect.runPromise(leases.read(SCOPE))).lease;
  const ids = await idsNow();
  say("started", { epoch: held.epoch, ids, held: ids.length });
  const handle = { writable: Effect.succeed(true), lease: Effect.succeed(held) };
  await writeLoop(handle, ids.length === 0 ? 1 : Number(ids[ids.length - 1].slice(1)) + 1);
} else if (ROLE === "follower") {
  // Never promoted: follows whoever holds the lease, before and after any promotion.
  say("follower");
  await Effect.runPromise(follow());
} else {
  const scope = Effect.runSync(Scope.make());
  say("standby");
  const successor = env("SUCCESSOR", "") === "" ? {} : { successor: env("SUCCESSOR", "") };
  const handle = await inScope(scope, (MODE === "database"
    ? database.writerLeases.standbyDatabase({ scope: SCOPE, leases, owner: NAME, ttlMillis: TTL, endpoint: ENDPOINT, pollMillis: 300, timeoutMillis: 500, leaderFor, ...successor })
    : database.writerLeases.standby({ partition: PARTITION, leases, owner: NAME, ttlMillis: TTL, endpoint: ENDPOINT, interval: "50 millis", pollMillis: 300, leaderFor, ...successor })).pipe(Effect.orDie));
  const ids = await idsNow();
  // The lease is created with expiresAt = the instant of the compare-and-set + ttl: when the promotion actually landed.
  say("promoted", { ids, casAt: handle.promotion.lease.expiresAt - TTL, epoch: handle.promotion.lease.epoch, lostPositions: handle.promotion.lostPositions, held: ids.length, head: await headNow() });
  await writeLoop(handle, ids.length === 0 ? 1 : Number(ids[ids.length - 1].slice(1)) + 1);
}
