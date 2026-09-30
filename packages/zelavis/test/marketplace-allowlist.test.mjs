import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { Effect } from "effect";

import { Zelavis, createMemorySystemStore } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalServiceSources } from "../dist/adapters/_local-runtime.js";

const runStep = (step) => Effect.runPromise(Effect.scoped(step));
const NPM = "https://registry.npmjs.org";
const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

// --- a tarball and a registry that serves it -------------------------------

function tarEntry(path, body) {
  const header = new Uint8Array(512);
  const write = (text, offset, length) => header.set(new TextEncoder().encode(text).subarray(0, length), offset);
  write(path, 0, 100);
  write("000644 ", 100, 8);
  write(`${body.length.toString(8).padStart(11, "0")} `, 124, 12);
  header[156] = "0".charCodeAt(0);
  write("ustar\0" + "00", 257, 8);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return [header, padded];
}

function makeTarball(files) {
  const parts = [];
  for (const [path, content] of Object.entries(files)) parts.push(...tarEntry(path, new TextEncoder().encode(content)));
  parts.push(new Uint8Array(1024));
  const tar = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { tar.set(part, offset); offset += part.length; }
  return new Uint8Array(gzipSync(tar));
}

const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function thing(version, body = "export default {}") {
  return makeTarball({
    "package/package.json": JSON.stringify({
      name: "@example/thing", version, type: "module",
      exports: { ".": { import: "./index.js" } },
      zelavis: { kind: "plugin", namespace: "thing" },
    }),
    "package/index.js": body,
  });
}

/** Serves `@example/thing` from a registry; counts what was requested. */
function registry(tarballs) {
  const calls = [];
  const fetcher = async (url) => {
    const target = String(url);
    calls.push(target);
    const version = /thing\/(?:-\/thing-)?([0-9.]+?)(?:\.tgz)?$/.exec(target)?.[1];
    const tarball = tarballs[version];
    if (!tarball) return new Response("missing", { status: 404 });
    if (target.endsWith(".tgz")) return new Response(tarball, { status: 200 });
    return new Response(JSON.stringify({
      version,
      dist: { tarball: `${NPM}/@example/thing/-/thing-${version}.tgz`, integrity: integrityOf(tarball) },
    }), { status: 200 });
  };
  fetcher.calls = calls;
  return fetcher;
}

// --- a signed allow-list ---------------------------------------------------

const { allowlist: lib } = await (async () => ({ allowlist: await import("../services/zelavis-marketplace/dist/allowlist/index.js") }))();
const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");

function listing(services, sequence = 2) {
  return {
    schemaVersion: 1, sequence,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    services,
  };
}

const entry = (versions) => ({
  name: "@example/thing", kind: "plugin", maintainer: "zelavis", title: "Thing", summary: "A thing.",
  versions, latest: versions.at(-1).version,
});

async function serveList(services, sequence) {
  const envelope = await lib.signAllowlist({ privateKey: keys.privateKey, keyId: "test-key", allowlist: listing(services, sequence) });
  return async () => new Response(JSON.stringify(envelope), { status: 200 });
}

async function sourcesFor(directory, marketplace) {
  return createLocalServiceSources({
    dataDirectory: directory, services: { marketplace }, isProjectRuntime: false, systemStore: createMemorySystemStore(),
  });
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-allow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("only listed packages install, at the listed version, with the listed digest", async (t) => {
  const directory = await scratch(t);
  const good = thing("1.0.0");
  const tampered = thing("1.0.0", "export default { evil: true }");
  const unlisted = thing("2.0.0");
  const fetcher = await serveList([entry([{ version: "1.0.0", integrity: integrityOf(good) }])]);
  const { servicePackages, marketplace } = await sourcesFor(directory, {
    sources: ["https://list.example/allowlist.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher,
  });
  assert.equal((await marketplace.control.refresh()).updated, true);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const refuse = (reference) => Effect.runPromise(Effect.flip(Effect.scoped(servicePackages.acquire({ reference }))));

  // Not listed at all, wrong version, a tag: refused before anything is fetched.
  globalThis.fetch = registry({ "1.0.0": good, "2.0.0": unlisted });
  const network = globalThis.fetch;
  for (const reference of ["npm:@example/other@1.0.0", "npm:@example/thing@2.0.0", "npm:@example/thing@latest"]) {
    const refusal = await refuse(reference);
    assert.equal(refusal._tag, "SourceRefused", reference);
    assert.match(refusal.reason, /allow-list/);
  }
  assert.equal(network.calls.length, 0, "nothing was fetched for a package that is not listed");

  // Listed, but the registry serves other bytes than the list vouches for.
  globalThis.fetch = registry({ "1.0.0": tampered });
  const mismatch = await refuse("npm:@example/thing@1.0.0");
  assert.equal(mismatch._tag, "SourceRefused");
  assert.match(mismatch.reason, /digest the allow-list vouches for/);

  // The real thing installs.
  globalThis.fetch = registry({ "1.0.0": good });
  const installed = await runStep(servicePackages.acquire({ reference: "npm:@example/thing@1.0.0" }));
  assert.equal(installed.resolved, "npm:@example/thing@1.0.0");
  assert.match(installed.specifier, /index\.js$/);
});

test("other kinds of source are refused while the allow-list gates installs", async (t) => {
  const directory = await scratch(t);
  const { servicePackages } = await sourcesFor(directory, { sources: [], keys: [] });
  const refusal = await Effect.runPromise(Effect.flip(Effect.scoped(
    servicePackages.acquire({ reference: "https://example.test/pkg.tgz" }))));
  assert.equal(refusal._tag, "SourceRefused");
});

test("switching the gate off leaves only the explicit source policy", async (t) => {
  const directory = await scratch(t);
  const off = await sourcesFor(directory, { allowlist: false });
  assert.equal(off.servicePackages.acquire, undefined, "no sources configured, so no acquisition");
  const on = await sourcesFor(directory, {});
  assert.equal(typeof on.servicePackages.acquire, "function");
});

test("what the list vouches for is offered by the marketplace at the next start", async (t) => {
  const directory = await scratch(t);
  const good = thing("1.0.0");
  const fetcher = await serveList([entry([{ version: "1.0.0", integrity: integrityOf(good) }])]);
  const first = await sourcesFor(directory, { sources: ["https://list.example/a.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher });
  await first.marketplace.control.refresh();

  // A restart shares the System Store, so it starts from the cached list.
  const store = createMemorySystemStore();
  const withStore = (marketplace) => createLocalServiceSources({
    dataDirectory: directory, services: { marketplace }, isProjectRuntime: false, systemStore: store,
  });
  const a = await withStore({ sources: ["https://list.example/a.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher });
  assert.equal(a.serviceRegistry.catalog.some((c) => c.service.name === "@example/thing"), false, "nothing cached yet");
  await a.marketplace.control.refresh();
  const b = await withStore({ sources: ["https://list.example/a.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher });
  const offered = b.serviceRegistry.catalog.find((c) => c.service.name === "@example/thing");
  assert.equal(offered.status, "available");
  assert.equal(offered.service.marketplace.title, "Thing");
  assert.equal(offered.specifier, "npm:@example/thing@1.0.0");
});

test("in development, an official service in the local checkout stands in for its npm copy", async (t) => {
  const directory = await scratch(t);
  const checkout = join(directory, "zelavis-services");
  await mkdir(join(checkout, "wordpress"), { recursive: true });
  await writeFile(join(checkout, "wordpress", "package.json"), JSON.stringify({
    name: "@zelavis/wordpress", version: "7.1.0",
    zelavis: { kind: "app", marketplace: { title: "WordPress", summary: "A site." }, project: { runtimeKinds: ["native"] } },
  }));
  await mkdir(join(checkout, "not-a-service"), { recursive: true });
  await writeFile(join(checkout, "not-a-service", "package.json"), JSON.stringify({ name: "plain", version: "1.0.0" }));

  const { serviceRegistry, marketplace } = await sourcesFor(directory, { officialServicesDirectory: checkout });
  const local = serviceRegistry.catalog.find((c) => c.service.name === "@zelavis/wordpress");
  assert.equal(local.status, "available");
  assert.equal(local.specifier, join(checkout, "wordpress"));
  assert.equal(local.service.version, "7.1.0");
  assert.deepEqual(local.service.project, { runtimeKinds: ["native"] });
  assert.equal(serviceRegistry.catalog.some((c) => c.service.name === "plain"), false);
  assert.deepEqual(marketplace.managedDirectories, [checkout]);
});

test("a Project runtime has no marketplace", async (t) => {
  const directory = await scratch(t);
  const project = await createLocalServiceSources({
    dataDirectory: directory, services: { marketplace: { sources: [] } }, isProjectRuntime: true, systemStore: createMemorySystemStore(),
  });
  assert.equal(project.marketplace, undefined);
});

test("operators can see how current the list is, and refresh it, over HTTP", async (t) => {
  const directory = await scratch(t);
  const good = thing("1.0.0");
  const fetcher = await serveList([entry([{ version: "1.0.0", integrity: integrityOf(good) }])], 7);
  const zv = new Zelavis({ adapter: nodeAdapter({
    dataDirectory: directory,
    services: { marketplace: { sources: ["https://list.example/a.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher } },
  }) });
  t.after(() => zv.close());
  const call = (path, principal, method = "GET") => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/marketplace/allowlist${path}`, { method }), { principal });
  const viewer = { id: "v", type: "user", permissions: ["marketplace.view"] };
  const nobody = { id: "n", type: "user", permissions: [] };

  assert.equal((await call("", nobody)).status, 403);
  assert.equal((await call("/refresh", viewer, "POST")).status, 403, "refreshing needs service-management authority");

  const refreshed = await (await call("/refresh", OWNER.principal, "POST")).json();
  assert.equal(refreshed.updated, true);
  assert.deepEqual(refreshed.attempts.map((a) => a.outcome), ["ok"]);
  assert.equal(refreshed.list.sequence, 7);

  const status = await (await call("", viewer)).json();
  assert.equal(status.gated, true);
  assert.equal(status.sources, 1);
  assert.equal(status.list.status, "fresh");
  assert.equal(status.list.services, 1);
  assert.equal(status.list.origin, "cache");
});

test("the list is the same over HTTP, the SDK and the CLI, and installs are described without their reference", async (t) => {
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runCli } = await import("../dist/cli/commands.js");
  const directory = await scratch(t);
  const checkout = join(directory, "zelavis-services");
  await mkdir(join(checkout, "site"), { recursive: true });
  await writeFile(join(checkout, "site", "package.json"), JSON.stringify({
    name: "@zelavis/site", version: "1.0.0", zelavis: { kind: "plugin", namespace: "site", marketplace: { title: "Site" } },
  }));
  const good = thing("1.0.0");
  const fetcher = await serveList([entry([{ version: "1.0.0", integrity: integrityOf(good) }])], 3);
  const zv = new Zelavis({ adapter: nodeAdapter({
    dataDirectory: directory,
    services: { marketplace: { sources: ["https://list.example/a.json"], keys: [{ keyId: "test-key", publicKey }], fetch: fetcher, officialServicesDirectory: checkout } },
  }) });
  t.after(() => zv.close());
  const send = (url, init) => zv.fetch(new Request(url, init), OWNER);
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: send });

  const viaHttp = await (await send("http://localhost/zelavis/api/v1/runtime/marketplace/allowlist/refresh", { method: "POST" })).json();
  assert.equal(viaHttp.updated, true);
  const sdk = await client.marketplace.allowlist();
  const http = await (await send("http://localhost/zelavis/api/v1/runtime/marketplace/allowlist")).json();
  assert.deepEqual(sdk, http);
  assert.equal(sdk.list.sequence, 3);

  const original = { fetch: globalThis.fetch, log: console.log };
  const out = [];
  globalThis.fetch = send;
  console.log = (value) => out.push(value);
  try {
    await runCli(["marketplace", "allowlist", "--url", "http://localhost/zelavis", "--json"]);
  } finally {
    globalThis.fetch = original.fetch;
    console.log = original.log;
  }
  assert.deepEqual(JSON.parse(out.join("\n")), http);

  const services = (await (await send("http://localhost/zelavis/api/v1/runtime/services")).json()).services;
  const site = services.find((s) => s.name === "@zelavis/site");
  assert.equal(site.installVia, "activate", "a checkout copy is switched on in place");
  assert.ok(!JSON.stringify(services).includes(checkout), "no path is exposed");
  assert.ok(!JSON.stringify(services).includes("npm:@example/thing"), "no acquisition reference is exposed");
});
