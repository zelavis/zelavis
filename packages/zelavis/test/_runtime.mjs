// A real Platform in this process, with an owner signed in, for parity tests of the operations that belong to the Platform
// itself. The route is reached with `send`, the SDK through `client`, and a CLI command through `cli`, and all three go through
// the same runtime, so what one says another cannot differ from.
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

export const OWNER = { id: "owner", type: "user", permissions: ["*"] };
const ROOT = "http://localhost/zelavis";

export async function platform(t, options = {}) {
  let principal = OWNER;
  const runtime = await zelavis({ systemStore: createMemorySystemStore(), resolvePrincipal: () => principal, ...options });
  t.after(() => runtime.close());
  const through = (input, init) => runtime.fetch(new Request(input, init));
  const send = async (method, path, body) => {
    const response = await through(`${ROOT}/api/v1${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!response.ok) throw Object.assign(new Error(parsed?.error ?? text), { status: response.status, body: parsed });
    return parsed;
  };
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through });
  /** Runs one CLI command with its HTTP routed into this runtime; its `--json` output, parsed. */
  const cli = async (command, args) => {
    const realFetch = globalThis.fetch, realLog = console.log, lines = [];
    globalThis.fetch = through;
    console.log = (...parts) => lines.push(parts.join(" "));
    try { await command([...args, "--url", ROOT, "--json"]); } finally { globalThis.fetch = realFetch; console.log = realLog; }
    return lines.length ? JSON.parse(lines.join("\n")) : undefined;
  };
  return { runtime, send, client, cli, through, as: (next) => { principal = next; } };
}

/** What a step came to: its answer with run-to-run values (times, generated ids) taken out, or the refusal's message. */
export const outcome = async (run) => {
  try {
    const answer = await run();
    return { answer: JSON.parse(JSON.stringify(answer ?? null, (key, entry) => (/(At|Time|timestamp)$/.test(key) || key === "at" ? undefined : entry))) };
  } catch (error) {
    return { refused: String(error?.body?.error ?? error?.message ?? error) };
  }
};

/** What a client call or a CLI command asked of the network: method, path under the API root and body, answered with `{}`. */
const asked = async (call) => {
  const requests = [];
  const fetchImplementation = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", path: url.pathname.replace("/zelavis/api/v1", "") + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const path = url.pathname.replace("/zelavis/api/v1", "");
    // The service commands read the registry before they change it; give them the shape they expect.
    if ((init?.method ?? "GET") === "GET" && path === "/runtime/services") return Response.json({ services: [{ name: "x", status: "available" }] });
    if (path.startsWith("/runtime/extensions")) return Response.json({ extensionPoints: [] });
    return Response.json({ services: [{ name: "x", status: "installed" }], service: { name: "x", status: "installed" } });
  };
  await call(fetchImplementation);
  return requests;
};
export const viaSdk = (use) => asked((fetchImplementation) => use(createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: fetchImplementation })));
export const viaCli = (command, args) => asked(async (fetchImplementation) => {
  const realFetch = globalThis.fetch, realLog = console.log;
  globalThis.fetch = fetchImplementation; console.log = () => {};
  try { await command([...args, "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = realFetch; console.log = realLog; }
});
