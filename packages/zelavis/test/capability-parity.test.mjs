// Every public operation is reachable from the SDK and the CLI.
//
// Derived, not listed: the operations are what a composed Platform's OpenAPI document names, plus the database and
// storage services a Project runtime mounts (reached through the Project proxy). SDK coverage is recorded by calling
// every client method against a fetch that notes which operation each request lands on; CLI coverage is the SDK
// methods the CLI source calls. What neither finds must be declared (an SDK method that exists, a CLI action its
// usage names, both checked here) or exempted with the reason it is not an operation a person calls. A new route
// with no SDK method or no CLI command fails this test.
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../dist/cli/commands.js";
import { readdirSync, readFileSync } from "node:fs";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { defineDatabaseService } from "../dist/db/index.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { resolveStorageEndpointGroup } from "../dist/platform/storage.js";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const collect = async () => {
  const runtime = await zelavis({ systemStore: createMemorySystemStore() });
  const spec = (await runtime.plain({ url: "/zelavis/api/v1/runtime/openapi.json" })).body;
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) for (const method of Object.keys(methods)) ops.push({ id: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ":$1") });
  const dir = mkdtempSync(join(tmpdir(), "zv-parity-"));
  const db = await openNodeDatabase({ directory: join(dir, "shards"), crossTenantRefresh: false });
  const PROXY = "/zelavis/api/v1/runtime/projects/:projectId/proxy/zelavis/api/v1";
  for (const route of defineDatabaseService(db.api).api.v1) ops.push({ id: `${route.method} database${route.path}`, method: route.method, path: `${PROXY}/database${route.path}`, alt: `/zelavis/api/v1/runtime/projects/:projectId/data${route.path}` });
  const storage = await resolveStorageEndpointGroup({ storage: createLocalFileStorage(join(dir, "files")) }, { rootPath: "/zelavis", apiPrefix: "/zelavis/api", apiVersion: "v1" });
  for (const route of storage.api.v1) ops.push({ id: `${route.method} storage${route.path}`, method: route.method, path: `${PROXY}/storage${route.path}` });
  for (const op of ops.filter((entry) => entry.path.startsWith("/zelavis/api/v1/workloads"))) op.alt = op.path.replace("/zelavis/api/v1/", `${PROXY}/`);
  await db.close();
  const toPattern = (template) => new RegExp(`^${template.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*[A-Za-z]+/g, ".+").replace(/:[A-Za-z]+/g, "[^/]+")}$`);
  for (const op of ops) { op.patterns = [toPattern(op.path), ...(op.alt ? [toPattern(op.alt)] : [])]; }

  const sdkOf = new Map();
  let current = "";
  const fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    const matches = ops.filter((op) => op.method === method && op.patterns.some((p) => p.test(url.pathname)));
    const best = matches.sort((a, b) => b.path.length - a.path.length)[0];
    if (best) { if (!sdkOf.has(best.id)) sdkOf.set(best.id, new Set()); sdkOf.get(best.id).add(current); }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch });
  const visited = new Set();
  const walk = async (value, path, depth) => {
    if (depth > 4 || value === null || (typeof value !== "object" && typeof value !== "function") || visited.has(value)) return;
    visited.add(value);
    for (const key of Object.keys(value)) {
      const child = value[key];
      const name = path ? `${path}.${key}` : key;
      if (typeof child === "function") {
        for (const args of [["p1", "x", "y", "z"], []]) {
          current = name;
          let result;
          try { result = child.apply(value, args); } catch { continue; }
          if (result && typeof result.then === "function") await result.then(() => {}, () => {});
          else if (result && typeof result === "object" && args.length > 0) await walk(result, name, depth + 1);
        }
      } else if (child && typeof child === "object") await walk(child, name, depth + 1);
    }
  };
  await walk(client, "", 0);

  const receivers = [[/workloads\(input\)\.([A-Za-z0-9_.]+)\(/g, "workloads."], [/input\.client\.([A-Za-z0-9_.]+)\(/g, ""], [/\bclient\.([A-Za-z0-9_.]+)\(/g, ""], [/\bapi\.([A-Za-z0-9_.]+)\(/g, "data."], [/files\(input\)\.([A-Za-z0-9_.]+)\(/g, "storage."], [/indexes\(input\)\.([A-Za-z0-9_.]+)\(/g, "crossTenantIndexes."], [/followers\(input\)\.([A-Za-z0-9_.]+)\(/g, "followers."], [/entities\(input\)\.([A-Za-z0-9_.]+)\(/g, "data.entities."]];
  const cliUses = new Set();
  for (const file of readdirSync("src/cli").filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(`src/cli/${file}`, "utf8");
    for (const [pattern, prefix] of receivers) for (const match of text.matchAll(pattern)) cliUses.add(prefix + match[1]);
  }
  return { ops, sdkOf, cliUses };
};

/** Not operations a person calls through a client: what each is instead. */
const EXEMPT = {
  "GET /zelavis/api/v1/runtime/service-page.css": "asset: the stylesheet extension pages load",
  "GET /zelavis/api/v1/runtime/service-elements.js": "asset: the component runtime extension pages load",
  "GET /zelavis/api/v1/runtime/service-ui.js": "asset: the service UI entry",
  "GET /zelavis/api/v1/runtime/service-ui.css": "asset: the service UI stylesheet",
  "GET /zelavis/api/v1/runtime/service-ui/{file}": "asset: service UI modules",
  "GET /zelavis/api/v1/runtime/service-page-capability": "dashboard: mints the capability URL it frames an extension page at",
  "GET /zelavis/api/v1/runtime/page-capabilities/{token}/{bundle}/{path}": "asset: an extension page served at its capability URL",
  "GET /zelavis/api/v1/runtime/service-page-assets/{service}/{bundle}/{path}": "asset: a service page's files",
  "GET /zelavis/api/v1/runtime/openapi": "the API description itself",
  "GET /zelavis/api/v1/runtime/openapi.json": "the API description itself",
  "GET /zelavis/api/v1/auth/oauth/{provider}/callback": "browser redirect target of an OAuth sign-in",
  "GET /{path}": "frontend: the Project's or Platform's site",
  "GET /zelavis/{path}": "frontend: the dashboard",
  "GET database/menu/tables": "dashboard: dynamic menu items for the sidebar",
  ...Object.fromEntries(["GET", "POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
    [`${method} /zelavis/api/v1/runtime/projects/{projectId}/proxy/{path}`, "passthrough: the typed Project operations behind it are checked one by one"],
    [`${method} /zelavis/api/v1/runtime/projects/{projectId}/data/{path}`, "passthrough: the typed App data operations behind it are checked one by one"],
    [`${method} /zelavis/api/v1/workloads/http/{projectId}/{path}`, "ingress: a Project's own HTTP workload, called by its users"],
  ])),
};

/** Reached, but by calls the recorder cannot make with placeholder arguments, or by CLI code that is not a plain SDK call. */
const DECLARED = {
  "GET /zelavis/api/v1/runtime/host-operations/audit": { sdk: "hostOperations.audit", cli: "host-operations audit" },
  "PATCH /zelavis/api/v1/runtime/environment/sessions/{sessionId}": { sdk: "environment.updateSession", cli: "environment update-session" },
  "POST /zelavis/api/v1/runtime/edge/routes": { sdk: "edge.putRoute", cli: "edge publish" },
  "POST /zelavis/api/v1/runtime/assistant/threads/{threadId}/messages/stream": { sdk: "assistant.streamMessage", cli: "assistant stream" },
  "POST /zelavis/api/v1/runtime/services": { cli: "services register" },
  "GET /zelavis/api/v1/runtime/services/sources": { cli: "services sources" },
  "GET /zelavis/api/v1/runtime/extensions": { cli: "services list" },
  "PATCH /zelavis/api/v1/runtime/services/{name}": { cli: "services disable" },
  "GET /zelavis/api/v1/runtime/projects/{projectId}": { cli: "projects get" },
  "POST /zelavis/api/v1/runtime/projects/{projectId}/start": { cli: "projects start" },
  "POST /zelavis/api/v1/runtime/projects/{projectId}/stop": { cli: "projects stop" },
  "POST /zelavis/api/v1/runtime/projects/{projectId}/restart": { cli: "projects restart" },
  "DELETE database/documents/collections/:collection": { cli: "data drop-collection" },
  "GET database/tenants": { sdk: "projects.tenants", cli: "projects tenants" },
  "POST database/documents/write": { sdk: "data.documents.write", cli: "data write" },
  // Durable entities take one object naming the entity, which the recorder's placeholder arguments are not.
  "POST database/entities/:type/:id/messages": { sdk: "data.entities.send", cli: "entities send" },
  "GET database/entities/:type/:id/messages/:messageKey": { sdk: "data.entities.message", cli: "entities message" },
  "POST database/entities/:type/:id/messages/:messageKey/cancel": { sdk: "data.entities.cancel", cli: "entities cancel" },
  "GET database/entities/:type/:id/state": { sdk: "data.entities.state", cli: "entities state" },
  "GET database/entities/:type/:id/mailbox": { sdk: "data.entities.mailbox", cli: "entities mailbox" },
  "GET database/entities/:type/list": { sdk: "data.entities.list", cli: "entities list" },
  // A browser sends a signed upload through the Platform's public upload route, which forwards only this route.
  "PUT storage/uploads/:token": { sdk: "storage.upload", cli: "storage upload" },
};

const resolveSdk = (client, path) => {
  let value = client;
  for (const segment of path.split(".")) {
    if (typeof value === "function") value = value("p1");
    value = value?.[segment];
  }
  return value;
};

const usageText = async () => {
  const originalLog = console.log, originalError = console.error, lines = [];
  console.log = (line) => lines.push(String(line)); console.error = (line) => lines.push(String(line));
  try {
    await runCli(["--help"]).catch(() => {});
    for (const command of ["projects", "data", "nodes", "edge", "assistant", "environment", "host-operations", "services"]) await runCli([command, "--help"]).catch(() => {});
  } finally { console.log = originalLog; console.error = originalError; }
  return lines.join("\n").split("\n");
};

test("every public operation has a typed SDK method and a CLI command, or a stated exemption", async () => {
  const { ops, sdkOf, cliUses } = await collect();
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: async () => new Response("{}") });
  const usage = await usageText();
  const cliNamed = (declared) => {
    const [command, action] = declared.split(" ");
    return usage.some((line) => line.includes(`zelavis ${command} `) && new RegExp(`[<|\\s]${action.replace(/[-]/g, "\\-")}[|>\\s]`).test(`${line} `));
  };
  const check = (list, declaredMap = DECLARED) => {
  const problems = [];
  for (const op of list) {
    if (EXEMPT[op.id] !== undefined) continue;
    const declared = declaredMap[op.id] ?? {};
    const sdk = sdkOf.get(op.id);
    if (sdk === undefined) {
      if (declared.sdk === undefined) { problems.push(`${op.id}: no SDK method reaches it`); continue; }
      if (typeof resolveSdk(client, declared.sdk) !== "function") problems.push(`${op.id}: declared SDK method ${declared.sdk} does not exist`);
    }
    const viaCli = sdk !== undefined && [...sdk].some((name) => cliUses.has(name));
    if (!viaCli && !(declared.sdk !== undefined && cliUses.has(declared.sdk))) {
      if (declared.cli === undefined) problems.push(`${op.id}: no CLI command reaches it (SDK: ${[...(sdk ?? [declared.sdk])].join(", ")})`);
      else if (!cliNamed(declared.cli)) problems.push(`${op.id}: declared CLI command "zelavis ${declared.cli}" is not in its usage`);
    }
  }
  return problems;
  };
  const problems = check(ops);
  for (const id of [...Object.keys(EXEMPT), ...Object.keys(DECLARED)]) {
    if (!ops.some((op) => op.id === id)) problems.push(`${id}: listed here but no longer an operation; remove it`);
  }
  assert.deepEqual(problems, [], `${problems.length} operations lack parity:\n${problems.join("\n")}`);
  // Negative controls: a route nothing reaches is reported, and so is a declared CLI action that does not exist.
  assert.deepEqual(check([{ id: "POST /zelavis/api/v1/runtime/nothing", method: "POST", path: "/x", patterns: [] }]), ["POST /zelavis/api/v1/runtime/nothing: no SDK method reaches it"]);
  const startOp = ops.find((op) => op.id === "POST /zelavis/api/v1/runtime/projects/{projectId}/start");
  assert.match(check([startOp], { [startOp.id]: { cli: "projects launch-rocket" } }).join(), /is not in its usage/);
  assert.ok(ops.length > 250, "the operation list is the composed Platform's and the Project services'");
});
