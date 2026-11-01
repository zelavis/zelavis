// A leader in a process of its own: a database on disk serving its follower routes over HTTP, so a follower in
// another process reaches it the way it would reach another host. `POST /write` adds a post to a Tenant, so the
// test can write on the leader while the follower runs. Prints `listening <port>` once it answers.
import { createServer } from "node:http";
import { openNodeDatabase } from "../../dist/db/node-host.js";
import { leaderRoutes } from "./leader-routes.mjs";

const [directory] = process.argv.slice(2);
const opened = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"], crossTenantRefresh: false });
const answer = leaderRoutes(opened.api);
const docs = opened.api.forTenant("acme").documents;
await docs.createCollection({ name: "posts", columns: ["rank"] });
for (let at = 1; at <= 40; at++) await docs.insert({ collection: "posts", id: `p${at}`, data: { rank: at } });

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text.length === 0 ? undefined : JSON.parse(text);
    const url = new URL(request.url, "http://leader");
    const reply = url.pathname === "/write"
      ? opened.api.forTenant(body.tenant).documents.insert({ collection: "posts", id: body.id, data: { rank: body.rank } }).then(() => ({ status: 200, body: { written: body.id } }))
      : answer(request.method, url.pathname, body);
    reply.then(
      ({ status, body: out }) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(out)); },
      (error) => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); },
    );
  });
});
server.listen(0, "127.0.0.1", () => console.log(`listening ${server.address().port}`));
process.on("SIGTERM", () => { server.close(); opened.close().finally(() => process.exit(0)); });
