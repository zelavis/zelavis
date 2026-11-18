import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createMemorySystemStore } from "../dist/index.js";
import { collectDnsProviders } from "../dist/edge/dns-provider.js";
import { createEdgeDnsController, DNS_CONNECTIONS_NAMESPACE } from "../dist/edge/dns-connections.js";
import { createCloudflareDnsProvider } from "../dist/adapters/_dns-cloudflare.js";
import { fakeDnsProvider, FAKE_TOKEN, pluginEntry } from "./_dns-provider-fake.mjs";

const SECRET = "edge-dns-test-master-secret-0123456789";
const tagged = (code) => (error) => error?.code === code || error?.body?.code === code;
const targets = { a: ["203.0.113.7"], aaaa: ["2001:db8::7"] };

const controller = (fake, extra = {}) => {
  const store = extra.store ?? createMemorySystemStore();
  const { providers } = collectDnsProviders([pluginEntry(fake.plugin())], extra.builtIn ?? []);
  return { store, dns: createEdgeDnsController({ store, masterSecret: SECRET, providers, ...extra }) };
};

test("plugin providers are listed after built-in ones, and a plugin cannot take a built-in name", () => {
  const fake = fakeDnsProvider();
  const shadow = fakeDnsProvider({ name: "cloudflare" });
  const builtIn = [createCloudflareDnsProvider({ apiBase: "https://cloudflare.fake/client/v4" })];
  const { providers, refused } = collectDnsProviders([
    pluginEntry(shadow.plugin("@evil/cloudflare")), pluginEntry(fake.plugin()), pluginEntry(fakeDnsProvider({ name: "pending" }).plugin("@test/pending"), "available"),
  ], builtIn);
  assert.deepEqual(providers.map(({ definition, source, plugin }) => [definition.name, source, plugin]),
    [["cloudflare", "built-in", undefined], ["fakedns", "plugin", "@test/dns-fake"]]);
  assert.equal(providers[0].definition, builtIn[0]);
  assert.deepEqual(refused, [{ plugin: "@evil/cloudflare", name: "cloudflare", code: "dns_provider_conflict" }]);
});

test("connect keeps only encrypted credentials, checked against the provider first", async () => {
  const fake = fakeDnsProvider();
  const { store, dns } = controller(fake);
  await assert.rejects(dns.connect("fakedns", { credentials: { token: "wrong-token" } }), error =>
    tagged("dns_provider_failed")(error) && !error.message.includes("wrong-token"));
  await assert.rejects(dns.connect("fakedns", { credentials: { apiToken: FAKE_TOKEN } }), tagged("invalid_dns_connection"));
  await assert.rejects(dns.connect("missing", { credentials: { token: FAKE_TOKEN } }), tagged("dns_provider_unavailable"));
  assert.deepEqual(await dns.connect("fakedns", { credentials: { token: FAKE_TOKEN } }), { provider: "fakedns", revision: 1, connected: true });
  const stored = await store.get(DNS_CONNECTIONS_NAMESPACE, "fakedns");
  assert.equal(stored.value.credentials.algorithm, "AES-256-GCM");
  assert.ok(!JSON.stringify(stored.value).includes(FAKE_TOKEN));
  const { providers } = await dns.providers();
  assert.deepEqual(providers.map(({ name, connected, revision }) => ({ name, connected, revision })), [{ name: "fakedns", connected: true, revision: 1 }]);
  assert.ok(!JSON.stringify(providers).includes(FAKE_TOKEN));
  await assert.rejects(dns.connect("fakedns", { credentials: { token: FAKE_TOKEN }, expectedRevision: 0 }), tagged("dns_revision_conflict"));
  assert.equal((await dns.connect("fakedns", { credentials: { token: FAKE_TOKEN }, expectedRevision: 1 })).revision, 2);
});

test("zones are adopted from the connection's own list, bounded, and released only while nothing uses them", async () => {
  const fake = fakeDnsProvider({ zones: [{ id: "z1", apex: "one.com" }, { id: "z2", apex: "two.com" }, { id: "z3", apex: "example.com" }] });
  let inUse = false;
  const { dns } = controller(fake, { zoneInUse: () => Effect.succeed(inUse) });
  await assert.rejects(dns.adoptZone("apps.example.com", { provider: "fakedns", zoneId: "z3", hostedSubdomains: true, targets }), tagged("invalid_dns_connection"));
  await dns.connect("fakedns", { credentials: { token: FAKE_TOKEN } });
  const first = await dns.providerZones("fakedns");
  assert.deepEqual(first, { zones: [{ id: "z1", apex: "one.com" }, { id: "z2", apex: "two.com" }], next: "2" });
  await assert.rejects(dns.adoptZone("apps.example.com", { provider: "fakedns", zoneId: "z1", hostedSubdomains: true, targets }), tagged("dns_zone_not_found"));
  await assert.rejects(dns.adoptZone("apps.example.com", { provider: "fakedns", zoneId: "z3", hostedSubdomains: true, targets: { a: [], aaaa: [] } }),
    tagged("hosted_zone_unavailable"));
  const zone = await dns.adoptZone("Apps.Example.com", { provider: "fakedns", zoneId: "z3", hostedSubdomains: true, targets });
  assert.deepEqual({ apex: zone.apex, zoneId: zone.zoneId, revision: zone.revision }, { apex: "apps.example.com", zoneId: "z3", revision: 1 });
  assert.deepEqual((await dns.zones()).zones.map(({ apex }) => apex), ["apps.example.com"]);
  assert.equal((await Effect.runPromise(dns.access.hostedZoneFor("shop.apps.example.com")))?.apex, "apps.example.com");
  assert.equal(await Effect.runPromise(dns.access.hostedZoneFor("a.shop.apps.example.com")), undefined);
  assert.equal((await Effect.runPromise(dns.access.zoneFor("_acme-challenge.apps.example.com")))?.apex, "apps.example.com");
  await assert.rejects(dns.disconnect("fakedns"), tagged("dns_in_use"));
  inUse = true;
  await assert.rejects(dns.releaseZone("apps.example.com"), tagged("dns_in_use"));
  inUse = false;
  await dns.releaseZone("apps.example.com");
  await assert.rejects(dns.releaseZone("apps.example.com"), tagged("dns_zone_not_found"));
  await dns.disconnect("fakedns");
  assert.deepEqual((await dns.providers()).providers.map(({ connected }) => connected), [false]);
});

test("a provider that does not answer fails within its deadline, logs no credential, and frees its permit", async () => {
  const fake = fakeDnsProvider();
  const { dns } = controller(fake, { callTimeoutMs: 300 });
  await dns.connect("fakedns", { credentials: { token: FAKE_TOKEN } });
  const lines = [];
  const realLog = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  fake.hang(true);
  const started = Date.now();
  try {
    await assert.rejects(Promise.all(Array.from({ length: 6 }, () => dns.providerZones("fakedns"))), error =>
      tagged("dns_provider_failed")(error) && /did not answer/.test(error.message));
  } finally {
    fake.hang(false);
    console.log = realLog;
  }
  assert.ok(Date.now() - started < 3_000);
  assert.equal((await dns.providerZones("fakedns")).zones.length, 1);
  fake.failNext(`upstream says ${FAKE_TOKEN} is rate limited`);
  await assert.rejects(dns.providerZones("fakedns"), error => tagged("dns_provider_failed")(error) && !error.message.includes(FAKE_TOKEN));
  assert.ok(lines.some(line => line.includes("edge.dns.call")));
  assert.ok(!lines.some(line => line.includes(FAKE_TOKEN)));
});

test("HTTP: operators manage connections and zones, customers see only hosted zone apexes", async (t) => {
  const { platform } = await import("./_runtime.mjs");
  const fake = fakeDnsProvider({ zones: [{ id: "zone-example", apex: "example.com" }] });
  const p = await platform(t, {
    serviceRegistry: { catalog: [
      pluginEntry(fake.plugin()),
      pluginEntry(fakeDnsProvider({ name: "cloudflare" }).plugin("@evil/cloudflare")),
      { service: { name: "@test/app", version: "1.0.0", kind: "app", project: { runtimeKinds: ["native"] } }, source: "official", status: "installed", specifier: "@test/app" },
    ] },
    edgeDnsProviders: [createCloudflareDnsProvider({ apiBase: "https://cloudflare.fake/client/v4" })],
    projectDomainIngress: { dns: { resolveTxt: async () => [] }, probe: async () => true },
    projectRuntime: {
      name: "test", runtimeKinds: ["native"], capabilities: () => ({ statelessRuntimeReplicas: false }),
      prepare: () => undefined, start: () => ({ status: "running", url: "http://127.0.0.1:1" }),
      status: () => ({ status: "stopped" }), stop: () => ({ status: "stopped" }),
      destroy: () => undefined, logs: () => [], close: () => undefined,
    },
  });
  await p.client.projects.create({ id: "alpha", name: "alpha", recipeName: "@test/app", start: false });
  const { providers } = await p.send("GET", "/runtime/edge/dns/providers");
  assert.deepEqual(providers.map(({ name, source, plugin, connected }) => [name, source, plugin, connected]),
    [["cloudflare", "built-in", undefined, false], ["fakedns", "plugin", "@test/dns-fake", false]]);
  assert.match(providers[0].tokenGuidance, /Zone → DNS → Edit/);

  assert.deepEqual(await p.send("PUT", "/runtime/edge/dns/connections/fakedns", { credentials: { token: FAKE_TOKEN } }),
    { provider: "fakedns", revision: 1, connected: true });
  await assert.rejects(p.send("PUT", "/runtime/edge/dns/connections/fakedns", { credentials: { token: FAKE_TOKEN }, extra: 1 }),
    error => error.status === 400 && error.body.code === "invalid_dns_connection");
  await assert.rejects(p.send("PUT", "/runtime/edge/dns/connections/absent", { credentials: { token: FAKE_TOKEN } }),
    error => error.status === 503 && error.body.code === "dns_provider_unavailable");
  fake.failNext(`provider rejected ${FAKE_TOKEN}`);
  await assert.rejects(p.send("GET", "/runtime/edge/dns/connections/fakedns/zones"),
    error => error.status === 502 && error.body.code === "dns_provider_failed" && !JSON.stringify(error.body).includes(FAKE_TOKEN));
  assert.deepEqual(await p.send("GET", "/runtime/edge/dns/connections/fakedns/zones"), { zones: [{ id: "zone-example", apex: "example.com" }] });
  const listed = await p.send("GET", "/runtime/edge/dns/providers");
  assert.ok(!JSON.stringify(listed).includes(FAKE_TOKEN));
  assert.equal(listed.providers[1].connected, true);

  const zone = await p.send("PUT", "/runtime/edge/dns/zones/apps.example.com", {
    provider: "fakedns", zoneId: "zone-example", hostedSubdomains: true, targets: { a: ["203.0.113.7"], aaaa: [] },
  });
  assert.equal(zone.revision, 1);
  assert.deepEqual((await p.send("GET", "/runtime/edge/dns/zones")).zones.map(({ apex }) => apex), ["apps.example.com"]);
  // The SDK and the CLI reach the same operations and answers.
  // Commands print their JSON with console.log, as the runtime's log lines do; keep only the command's own output.
  const quiet = (command) => async (args) => {
    const captured = console.log;
    console.log = (...parts) => { if (!/^\[\d{2}:\d{2}/.test(String(parts[0]))) captured(...parts); };
    try { await command(args); } finally { console.log = captured; }
  };
  const runEdgeCommand = quiet((await import("../dist/cli/edge.js")).runEdgeCommand);
  const runProjectsCommand = quiet((await import("../dist/cli/projects.js")).runProjectsCommand);
  assert.deepEqual(await p.client.edge.dns.zones(), await p.send("GET", "/runtime/edge/dns/zones"));
  assert.deepEqual(await p.cli(runEdgeCommand, ["dns-zones"]), await p.client.edge.dns.zones());
  assert.deepEqual(await p.cli(runEdgeCommand, ["dns-providers"]), await p.client.edge.dns.providers());
  assert.deepEqual(await p.cli(runEdgeCommand, ["dns-provider-zones", "fakedns"]), await p.client.edge.dns.providerZones("fakedns"));
  await assert.rejects(p.cli(runEdgeCommand, ["dns-adopt-zone", "apps.example.com"]), /requires --data/);
  assert.equal((await p.cli(runEdgeCommand, ["dns-adopt-zone", "apps.example.com", "--data", JSON.stringify({
    provider: "fakedns", zoneId: "zone-example", hostedSubdomains: true, targets: { a: ["203.0.113.7"], aaaa: [] }, expectedRevision: 1,
  })])).revision, 2);
  assert.deepEqual(await p.cli(runProjectsCommand, ["hosted-zones", "alpha"]), await p.client.projects.hostedZones("alpha"));

  p.as(undefined);
  await assert.rejects(p.send("GET", "/runtime/edge/dns/providers"), { status: 401 });
  p.as({ id: "customer", type: "user", grants: [{ permission: "project.domains.manage", scope: { type: "project", projectId: "alpha" } }] });
  for (const [method, path, body] of [["GET", "/runtime/edge/dns/providers"], ["GET", "/runtime/edge/dns/zones"],
    ["PUT", "/runtime/edge/dns/connections/fakedns", { credentials: { token: FAKE_TOKEN } }], ["DELETE", "/runtime/edge/dns/zones/apps.example.com"]]) {
    await assert.rejects(p.send(method, path, body), { status: 403 }, `${method} ${path}`);
  }
  assert.deepEqual(await p.send("GET", "/runtime/projects/alpha/domains/hosted-zones"), { zones: [{ apex: "apps.example.com" }] });
  await assert.rejects(p.send("GET", "/runtime/projects/beta/domains/hosted-zones"), { status: 403 });

  p.as({ id: "owner", type: "user", permissions: ["*"] });
  await assert.rejects(p.send("DELETE", "/runtime/edge/dns/connections/fakedns"), error => error.status === 409 && error.body.code === "dns_in_use");
  await p.send("DELETE", "/runtime/edge/dns/zones/apps.example.com");
  await p.send("DELETE", "/runtime/edge/dns/connections/fakedns");
  assert.equal((await p.send("GET", "/runtime/edge/dns/providers")).providers[1].connected, false);
});
