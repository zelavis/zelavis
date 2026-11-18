import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

// Provider-specific drivers (the Cloudflare DNS driver) sit behind the adapter boundary: the host adapter hands them to
// the composition, and nothing in the runtime-neutral layers names one.
const drivers = ["_dns-cloudflare", "_registrar-namecheap"];
const source = fileURLToPath(new URL("../src/", import.meta.url));
const allowed = new Set(["adapters/node.ts", ...drivers.map(name => `adapters/${name}.ts`)]);

const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);

test("only the Node adapter imports a provider driver", () => {
  const importers = files(source).filter(file => {
    const text = readFileSync(file, "utf8");
    const capacityImport = !relative(source, file).startsWith("adapters/capacity/") && [...text.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)]
      .some(([, specifier]) => specifier.startsWith(".") && relative(source, resolve(dirname(file), specifier)).startsWith("adapters/capacity/"));
    return capacityImport || drivers.some(name => new RegExp(`from\\s+["'][^"']*/${name}\\.js["']|import\\(\\s*["'][^"']*/${name}\\.js`).test(text));
  }).map(file => relative(source, file).split("\\").join("/")).filter(path => !allowed.has(path));
  assert.deepEqual(importers, []);
});

test("Edge, core and the SDK load no provider driver", () => {
  const hook = `
import { registerHooks } from "node:module";
const seen = [];
registerHooks({ load(url, context, next) { seen.push(url); return next(url, context); } });
process.on("exit", () => { process.stderr.write("\\nLOADED " + JSON.stringify(seen) + "\\n"); });
`;
  const entries = ["edge/index.js", "edge/dns-provider.js", "edge/registrar-provider.js", "core/index.js", "sdk/fetch.js", "backends/index.js", "platform/cloud-engine.js"]
    .map(path => new URL(`../dist/${path}`, import.meta.url).href);
  const program = entries.map(url => `await import(${JSON.stringify(url)});`).join("\n");
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, "--input-type=module", "-e", program], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stderr.split("\n").find(entry => entry.startsWith("LOADED "));
  assert.ok(line, result.stderr);
  const loaded = JSON.parse(line.slice("LOADED ".length));
  assert.ok(loaded.some(url => url.endsWith("/dist/edge/index.js")), "the recorder saw the entries");
  assert.deepEqual(loaded.filter(url => url.includes("/dist/adapters/capacity/") || drivers.some(name => url.endsWith(`/dist/adapters/${name}.js`))), []);
});


test("a composed Platform with enrollment and no connection never loads capacity code", () => {
  const hook = `
import { registerHooks } from "node:module";
const seen = [];
registerHooks({ load(url, context, next) { seen.push(url); return next(url, context); } });
process.on("exit", () => process.stderr.write("\\nLOADED " + JSON.stringify(seen.filter(url => url.includes("/dist/adapters/"))) + "\\n"));
`;
  const runtime = new URL("./_runtime.mjs", import.meta.url).href;
  const engine = new URL("../dist/platform/cloud-engine.js", import.meta.url).href;
  const storeModule = new URL("../dist/system-store.js", import.meta.url).href;
  const program = `
const { platform } = await import(${JSON.stringify(runtime)});
const { composeCloudCapacity } = await import(${JSON.stringify(engine)});
const { createMemorySystemStore } = await import(${JSON.stringify(storeModule)});
const { Effect } = await import("effect");
const cloudCapacity = await Effect.runPromise(composeCloudCapacity({ store: createMemorySystemStore(), masterSecret: "secret", platformId: "p", bundlePath: "/missing.js", endpoint: { url: "https://localhost:8444", fingerprint: "ab".repeat(32) }, workDir: "/tmp" }));
let close;
const { send } = await platform({ after: fn => { close = fn; } }, { cloudCapacity, enrollmentEndpoint: { url: "https://localhost:8444", fingerprint: "ab".repeat(32) } });
try { const result = await send("GET", "/runtime/cloud"); if (result.connection !== null) throw new Error("unexpected connection"); } finally { await close(); }
`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, "--input-type=module", "-e", program], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stderr.split("\n").find(line => line.startsWith("LOADED ")).slice(7));
  assert.deepEqual(loaded.filter(url => url.includes("/dist/adapters/capacity/")), []);
});
