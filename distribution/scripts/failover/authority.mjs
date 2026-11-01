// The lease authority of the failover drill: the Platform's writer-lease routes (`createWriterLeaseRoutes`) over an
// in-memory store, served on a private Docker network. In a real installation the same routes run in the Platform over
// its System Store. Not shipped; used by qualify-failover.mjs only.
import { createServer } from "node:http";
import { createWriterLeaseRoutes } from "/repo/packages/zelavis/dist/platform/writer-lease-routes.js";
import { memoryLeaseStore } from "/repo/packages/zelavis/dist/db/writer-lease.js";

const TOKEN = process.env.TOKEN ?? "drill-token";
const routes = createWriterLeaseRoutes(memoryLeaseStore());
const prefix = "/zelavis/api/v1/runtime";

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "no" });
  const url = new URL(request.url, "http://authority");
  const segments = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  for (const route of routes) {
    const pattern = route.path.split("/").filter(Boolean);
    if (route.method !== request.method || pattern.length !== segments.length) continue;
    const params = {};
    pattern.forEach((part, at) => { if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[at]); });
    const answer = await route.handler({ params, query: url.searchParams, body: text === "" ? undefined : JSON.parse(text), principal: { id: "drill", permissions: ["*"] }, headers: {}, request: undefined });
    return send(answer.status ?? 200, answer.body);
  }
  return send(404, { error: "not found" });
}).listen(8080, () => console.log(JSON.stringify({ event: "authority-up" })));
