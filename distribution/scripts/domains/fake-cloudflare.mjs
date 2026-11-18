// The built-in driver's four calls, backed by the same records the DNS authority serves.
import { createServer } from "node:http";
import { once } from "node:events";

export async function startFakeCloudflare(scope, { apex, token, authority }) {
  const zoneId = "qualificationZone";
  const records = new Map();
  let nextId = 0;
  const matching = (name, type) => [...records.values()].filter(row => row.name === name && row.type === type);
  function updateAuthority(name, type) {
    const answers = matching(name, type).map(({ content }) => type === "TXT"
      ? { type, strings: [content] } : { type, address: content });
    if (answers.length) authority.set(name, type, answers);
    else authority.remove(name, type);
  }

  const server = createServer(async (request, response) => {
    const reply = (status, result) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status < 400 ? { success: true, result } :
        { success: false, errors: [{ message: result }] }));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return reply(403, "Authentication error");
    const { pathname, searchParams } = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && pathname === "/client/v4/zones") return reply(200, [{ id: zoneId, name: apex }]);

    const path = `/client/v4/zones/${zoneId}/dns_records`;
    if (request.method === "GET" && pathname === path) {
      return reply(200, matching(searchParams.get("name"), searchParams.get("type")));
    }
    if (request.method === "POST" && pathname === path) {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4096) return reply(413, "Record body too large");
          chunks.push(chunk);
        }
        const { name, type, ttl, content } = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof name !== "string" || (name !== apex && !name.endsWith(`.${apex}`)) ||
            !["TXT", "A", "AAAA"].includes(type) || typeof content !== "string" || !Number.isInteger(ttl)) {
          return reply(400, "Invalid record");
        }
        const id = `qualificationRecord${++nextId}`;
        const row = { id, name, type, ttl, content };
        records.set(id, row);
        updateAuthority(name, type);
        return reply(200, row);
      } catch (error) {
        return reply(400, error instanceof SyntaxError ? "Malformed record JSON" : "Record could not be stored");
      }
    }
    if (request.method === "DELETE" && pathname.startsWith(`${path}/`)) {
      const id = pathname.slice(path.length + 1);
      const row = records.get(id);
      if (!row) return reply(404, "Record does not exist");
      records.delete(id);
      updateAuthority(row.name, row.type);
      return reply(200, { id });
    }
    return reply(404, "Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  scope.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { apiBase: `http://127.0.0.1:${server.address().port}/client/v4` };
}
