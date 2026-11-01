// One database node of the failover drill, in its own container: a Zelavis database with the leader transport served
// over HTTP, a writer (holds the lease and writes) or a standby (follows, and takes over when the lease lapses).
// It prints one JSON line per event; the orchestrator reads them with `docker logs`. Not shipped.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Effect, Exit, Fiber, Scope } from "effect";
import { openNodeDatabase } from "/repo/packages/zelavis/dist/db/node-host.js";
import {
  defineDatabaseService, httpLeaseStore, remoteAcknowledgments, remoteLeader, writeAcknowledged,
} from "/repo/packages/zelavis/dist/db/index.js";
import { createZelavisClient } from "/repo/packages/zelavis/dist/sdk/fetch.js";

const env = (name, fallback) => process.env[name] ?? fallback;
const NAME = env("NAME", "node");
const ROLE = env("ROLE", "writer");
const PEER = env("PEER", "");
const AUTHORITY = env("AUTHORITY", "http://authority:8080");
const TOKEN = env("TOKEN", "drill-token");
const TTL = Number(env("TTL_MILLIS", "3000"));
const PARTITION = "acme";
const say = (event, extra = {}) => console.log(JSON.stringify({ event, node: NAME, at: Date.now(), ...extra }));

mkdirSync("/data/shards", { recursive: true });
const opened = await openNodeDatabase({ directory: "/data/shards", crossTenantRefresh: false });
const { database, api } = opened;
const documents = api.forTenant(PARTITION).documents;

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

const leases = httpLeaseStore({ apiRoot: `${AUTHORITY}/zelavis/api/v1`, token: TOKEN, timeoutMillis: 1000 });
const remote = () => createZelavisClient({ baseUrl: PEER, rootPath: "/zelavis" }).followers("p1");
const inScope = (scope, effect) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)));
const idsNow = async () => (await documents.findMany({ collection: "posts" })).map((doc) => doc.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const headNow = async () => (await Effect.runPromise(Effect.flatMap(database.followers.source(PARTITION), (source) => source.stats))).head;

// ---- writing ----
let writing = false;
const writeLoop = async (handle, start) => {
  writing = true;
  const source = await Effect.runPromise(database.followers.source(PARTITION));
  const acknowledgments = await Effect.runPromise(database.followers.acknowledgments(PARTITION));
  for (let n = start; writing; n++) {
    const id = `p${n}`;
    const insert = database.forTenant(PARTITION).documents.insert({ collection: "posts", id, data: { n, by: NAME } });
    // With a follower reporting, a write is acknowledged once the follower holds it: that is the promise a failover keeps.
    const exit = await Effect.runPromiseExit(writeAcknowledged(source, acknowledgments, insert, { followers: 1, timeout: "1500 millis" }));
    // When the write actually committed: the document's own creation time, not when this line is printed.
    const committedAt = async () => Date.parse((await documents.findById({ collection: "posts", id }))?.createdAt ?? "");
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
  const docs = (await documents.findMany({ collection: "posts" })).map((doc) => [doc.id, doc.data.by]).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
  say("final", { ids: docs.map(([id]) => id), by: Object.fromEntries(docs), head: await headNow() });
  process.exit(0);
};
process.on("SIGTERM", () => { writing = false; final(); });
// SIGUSR2: stop writing and keep serving, so a follower can level out before the drill compares the two.
process.on("SIGUSR2", () => { writing = false; say("quiesced"); });

if (ROLE === "writer") {
  await documents.createCollection({ name: "posts" });
  const scope = Effect.runSync(Scope.make());
  const handle = await inScope(scope, database.writerLeases.hold({ partition: PARTITION, leases, owner: NAME, ttlMillis: TTL }));
  say("writer", { epoch: (await Effect.runPromise(handle.lease)).epoch });
  await writeLoop(handle, 1);
  // Superseded: stop being a writer and follow the new one. What this node wrote past what was acknowledged is copied over.
  await Effect.runPromise(Scope.close(scope, Exit.void));
  say("following", { peer: PEER });
  // A follow that cannot reach the new writer ends; the node tries again until the network is back.
  for (;;) {
    await Effect.runPromise(database.followers.follow(remoteLeader(remote(), PARTITION), { partition: PARTITION, interval: "100 millis" }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => say("follow-failed", { cause: String(cause).slice(0, 200) })))));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} else {
  const scope = Effect.runSync(Scope.make());
  say("standby", { peer: PEER });
  const transport = remote();
  const handle = await inScope(scope, database.writerLeases.standby({
    partition: PARTITION, leases, owner: NAME, ttlMillis: TTL, interval: "50 millis",
    leader: remoteLeader(transport, PARTITION),
    acknowledgments: { name: NAME, to: remoteAcknowledgments(transport, PARTITION) },
  }).pipe(Effect.orDie));
  const ids = await idsNow();
  // The lease is created with expiresAt = the instant of the compare-and-set + ttl: when the promotion actually landed.
  say("promoted", { ids, casAt: handle.promotion.lease.expiresAt - TTL, epoch: handle.promotion.lease.epoch, lostPositions: handle.promotion.lostPositions, held: ids.length, head: await headNow() });
  await writeLoop(handle, ids.length === 0 ? 1 : Number(ids[ids.length - 1].slice(1)) + 1);
}
