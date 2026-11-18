import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareDnsProvider, cloudflareDnsProvider } from "../dist/adapters/_dns-cloudflare.js";

const TOKEN = "cf-test-token-never-shown";
const API = "https://cloudflare.fake/client/v4";

/** A fake of the four Cloudflare calls, recording what it was asked. */
function fake() {
  const asked = [];
  const zones = Array.from({ length: 120 }, (_, index) => ({ id: `zone${index}`, name: `z${index}.example.com` }));
  const records = new Map();
  let next = 1;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    asked.push({ method: init.method, path: url.pathname.replace("/client/v4", ""), search: url.search, body, authorization: init.headers?.authorization });
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    const path = url.pathname.replace("/client/v4", "");
    if (path === "/zones") {
      const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("per_page"));
      return reply(200, { success: true, result: zones.slice((page - 1) * size, page * size), result_info: { page, total_pages: Math.ceil(zones.length / size) } });
    }
    const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (!match) return reply(404, { success: false, errors: [{ message: "Not found" }] });
    if (init.method === "GET") {
      const found = [...records.values()].filter(row => row.name === url.searchParams.get("name") && row.type === url.searchParams.get("type"));
      return reply(200, { success: true, result: found });
    }
    if (init.method === "POST") {
      if (body.content === "refuse") return reply(400, { success: false, errors: [{ code: 81057, message: `Record already exists (token ${TOKEN})` }] });
      const row = { id: `rec${next++}`, ...body };
      records.set(row.id, row);
      return reply(200, { success: true, result: row });
    }
    if (!records.delete(match[2])) return reply(404, { success: false, errors: [{ code: 81044, message: "Record does not exist." }] });
    return reply(200, { success: true, result: { id: match[2] } });
  };
  return { asked, fetch, records };
}

test("the built-in definition names its one secret field and what the token can do", () => {
  assert.equal(cloudflareDnsProvider.name, "cloudflare");
  assert.deepEqual(cloudflareDnsProvider.credentials, [{ name: "apiToken", label: "API token", secret: true }]);
  assert.match(cloudflareDnsProvider.tokenGuidance, /Zone → DNS → Edit/);
});

test("pages zones, creates and deletes records, and treats a missing record as deleted", async () => {
  const api = fake();
  const client = createCloudflareDnsProvider({ apiBase: API }).createClient({ apiToken: TOKEN }, { fetch: api.fetch });
  const pages = [];
  let cursor;
  do {
    const page = await client.zones(cursor === undefined ? {} : { cursor });
    pages.push(page.zones.length);
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(pages, [50, 50, 20]);
  assert.deepEqual(api.asked.slice(0, 3).map(row => row.search), ["?page=1&per_page=50", "?page=2&per_page=50", "?page=3&per_page=50"]);

  const created = await client.create("zone1", { name: "shop.apps.example.com", type: "A", content: "203.0.113.7", ttl: 300 });
  assert.deepEqual(api.asked.at(-1).body, { type: "A", name: "shop.apps.example.com", content: "203.0.113.7", ttl: 300 });
  assert.equal(api.asked.at(-1).authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(await client.records("zone1", { name: "shop.apps.example.com", type: "A" }), [created]);
  await client.remove("zone1", created.id);
  await client.remove("zone1", created.id);
  assert.equal(api.records.size, 0);
});

test("a refusal carries Cloudflare's message but never the token", async () => {
  const api = fake();
  const client = createCloudflareDnsProvider({ apiBase: API }).createClient({ apiToken: TOKEN }, { fetch: api.fetch });
  await assert.rejects(client.create("zone1", { name: "x.example.com", type: "TXT", content: "refuse", ttl: 60 }), error => {
    assert.match(error.message, /Record already exists/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
  const wrong = createCloudflareDnsProvider({ apiBase: API }).createClient({ apiToken: "another-token" }, { fetch: api.fetch });
  await assert.rejects(wrong.zones({}), error => /Authentication error/.test(error.message) && !error.message.includes("another-token"));
  await assert.rejects(client.remove("../zones", "rec1"), /zone id is invalid/);
  const unreachable = createCloudflareDnsProvider({ apiBase: API }).createClient({ apiToken: TOKEN }, { fetch: async () => { throw new Error(`socket ${TOKEN}`); } });
  await assert.rejects(unreachable.zones({}), error => error.message === "Cloudflare could not be reached.");
});
