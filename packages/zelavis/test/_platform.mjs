// A fake Platform for parity tests: it hands the SDK's and the CLI's requests to the routes' own handlers, so nothing in
// between answers for them. Routes come from endpoint groups (`{ basePath, api: { v1: [...] } }`), found by method and path
// template, with `:name` and `*name` segments.
import assert from "node:assert/strict";

/** Routes with fewer parameters first, as a router prefers `/logs` to `/:id`. */
const specificity = (entry) => entry.names.length + (entry.wildcard ? 100 : 0);

export const routeTable = (groups) => groups.flatMap((group) => group.api.v1.map((route) => {
  const full = `${group.basePath}${route.path === "/" ? "" : route.path}`.replace(/\/+/g, "/");
  const names = [];
  const pattern = new RegExp(`^${full.replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return "([^/]+)"; }).replace(/\*([A-Za-z]+)/g, (_, name) => { names.push(name); return "(.+)"; })}$`);
  return { method: route.method, pattern, names, wildcard: full.includes("*"), route, context: group.context };
})).sort((left, right) => specificity(left) - specificity(right));

const respond = (answer) => {
  const headers = new Headers(answer.headers ?? {});
  const body = answer.body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || typeof body === "string") return new Response(body, { status: answer.status ?? 200, headers });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body ?? {}), { status: answer.status ?? 200, headers });
};

/** `fetch` for a Platform whose Project proxy reaches `routes` under `prefix`; each request is answered by the matching handler. */
export const fakePlatform = ({ prefix, routes, principal }) => async (input, init) => {
  const url = new URL(String(input));
  assert.ok(url.pathname.startsWith(prefix), `unexpected request ${url.pathname}`);
  const path = url.pathname.slice(prefix.length) || "/";
  const method = init?.method ?? "GET";
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(entry.names.map((name, at) => [name, decodeURIComponent(match[at + 1])]));
    const request = new Request(url, init);
    const text = request.headers.get("content-type")?.includes("json") ? await request.clone().text() : "";
    const body = text ? JSON.parse(text) : undefined;
    const answer = await entry.route.handler({ service: entry.context, params, query: url.searchParams, body, request, requestHeaders: request.headers, headers: Object.fromEntries(request.headers), principal });
    return respond(answer);
  }
  assert.fail(`no route ${method} ${path}`);
};

/** Runs a CLI command against `fetch`, handing back what it printed. */
export const runCli = async (command, args, fetchImplementation) => {
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
  globalThis.fetch = fetchImplementation;
  console.log = (line) => lines.push(String(line));
  try { await command(args); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  return lines.join("\n");
};

/** What differs run to run taken out: times and the ids a service generates. */
export const steady = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (/(At|Time|timestamp)$/.test(key) || key === "at" ? undefined : entry)));
