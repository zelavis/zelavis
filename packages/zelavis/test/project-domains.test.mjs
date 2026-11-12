import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createMemorySystemStore, createZelavisEdgeManager, createZelavisEdgeRouteStore } from "../dist/index.js";
import { createProjectDomainController, normalizeProjectDomainHostname, PROJECT_DOMAINS_NAMESPACE } from "../dist/edge/project-domains.js";
import { ensureProductionEdge } from "../dist/edge/production.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { platform } from "./_runtime.mjs";

const tagged = (code) => (error) => error?.code === code || error?.body?.code === code;
const external = hostname => ({ hostname, tlsMode: "external" });
const verify = (controller, projectId, domain) =>
  controller.verify(projectId, domain.hostname, { expectedRevision: domain.revision });
const fixture = (options = {}) => {
  const store = createMemorySystemStore(), routes = createZelavisEdgeRouteStore({ store });
  const txt = new Map();
  const projects = {
    view: async id => ({ id }),
    withLiveProject: (id, effect) => Effect.suspend(() => effect({ id })),
  };
  const start = (extra = {}) => createProjectDomainController({
    store, routes, projects: () => projects,
    ingress: { externalTarget: "http://127.0.0.1:3200", dns: { resolveTxt: async name => txt.get(name) ?? [] }, probe: async () => true },
    ...options, ...extra,
  });
  return { store, routes, txt, start };
};
const scoped = (permission, projectId) => ({ permission, scope: { type: "project", projectId } });

test("normalizes public ASCII hostnames and rejects invalid shapes", () => {
  assert.equal(normalizeProjectDomainHostname("WWW.Example.COM."), "www.example.com");
  assert.equal(normalizeProjectDomainHostname("xn--bcher-kva.example"), "xn--bcher-kva.example");
  for (const host of ["*.example.com", "example.com..", "http://example.com", "example.com:443", "a..example.com",
    "example.com/path", "localhost", "x.local", "x.internal", "x.home.arpa", "x.test", "127.0.0.1", "[::1]",
    "a.0x1", "example.com ", "bächer.example", "xn--invalid-.example", "a".repeat(64) + ".example.com"]) {
    assert.equal(normalizeProjectDomainHostname(host), undefined, host);
  }
});

test("pending challenges cannot reserve a host, CAS picks one proof, and a removed hostname receives a fresh revision", async () => {
  const f = fixture(), c = f.start();
  const { domain: a } = await c.add("a", external("SITE.EXAMPLE.COM."));
  const { domain: b } = await c.add("b", external("site.example.com"));
  assert.notEqual(a.challenge.value, b.challenge.value);
  assert.equal(await f.routes.getHostname(a.hostname), undefined);
  assert.deepEqual(await c.add("a", external(a.hostname)), { domain: a, created: false });
  f.txt.set(a.challenge.name, [[a.challenge.value.slice(0, 10), a.challenge.value.slice(10)], [b.challenge.value]]);
  const outcomes = await Promise.allSettled([verify(c, "a", a), verify(c, "b", b)]);
  const wins = outcomes.filter(result => result.status === "fulfilled");
  assert.equal(wins.length, 1);
  const active = wins[0].value;
  assert.equal(active.state, "active");
  assert.equal(active.challenge, undefined);
  assert.equal(active.publicUrl, "https://site.example.com/");
  assert.ok(outcomes.some(result => result.status === "rejected" && tagged("hostname_unavailable")(result.reason)));
  const row = await f.routes.getHostname(a.hostname);
  assert.equal(row.projectId, active.projectId);
  await assert.rejects(f.routes.putHostname({ ...row, scope: "platform", projectId: undefined, projectDomain: undefined }), /another scope/);
  await assert.rejects(f.routes.putHostname(row), /DNS verification/);
  await assert.rejects(f.routes.deleteHostname(a.hostname), /withdraw/);
  assert.equal(await f.routes.deleteProjectRoutes(active.projectId), 0);
  assert.deepEqual(await f.start().remove(active.projectId, a.hostname, active.revision), { removed: true, pending: false });
  assert.equal(await f.routes.getHostname(a.hostname), undefined);
  const replacement = (await c.add(active.projectId, external(a.hostname))).domain;
  assert.ok(replacement.revision > active.revision);
  await assert.rejects(c.remove(active.projectId, a.hostname, active.revision), tagged("domain_revision_conflict"));
  f.txt.set(replacement.challenge.name, [[replacement.challenge.value]]);
  const newOwner = await verify(c, active.projectId, replacement);
  assert.equal(newOwner.state, "active");
  assert.equal(await f.routes.releaseProjectHostname({ host: a.hostname, projectId: active.projectId, domainId: active.id }), false);
  assert.equal((await f.routes.getHostname(a.hostname)).projectDomain.domainId, replacement.id);
});

test("limits TXT attempts and current intents, refreshes expired challenges, and refuses corrupt state", async () => {
  let now = Date.now();
  const f = fixture({ now: () => now }), c = f.start();
  const { domain } = await c.add("a", external("example.com"));
  await assert.rejects(verify(c, "a", domain), tagged("dns_not_verified"));
  const after = (await c.list("a")).domains[0];
  assert.equal(after.issue, "dns_pending");
  await assert.rejects(verify(c, "a", after), error => tagged("domain_verification_busy")(error) && error.retryAfter === 30);
  for (let i = 0; i < 19; i++) await c.add("a", external(`sub-${i}.example.com`));
  await assert.rejects(c.add("a", external("limit.example.com")), tagged("domain_limit"));
  now += 25 * 60 * 60 * 1000;
  const fresh = (await c.add("a", external(domain.hostname))).domain;
  assert.notEqual(fresh.challenge.value, domain.challenge.value);
  assert.ok(fresh.revision > after.revision);
  assert.equal((await c.list("a")).domains.length, 1);
  f.store.set(PROJECT_DOMAINS_NAMESPACE, "a", { schemaVersion: 1, revision: 0, entries: [{ hostname: "invalid" }] });
  await assert.rejects(c.list("a"));
});

test("a restart can finish the persisted proof checkpoint without rerunning TXT", async () => {
  const f = fixture();
  let lookups = 0;
  const ingress = { externalTarget: "http://127.0.0.1:3200", dns: { resolveTxt: async name => {
    lookups++;
    return f.txt.get(name) ?? [];
  } }, probe: async () => true };
  const interrupted = f.start({ ingress, routes: { ...f.routes, claimProjectHostname: async () => {
    throw new Error("injected failure after durable DNS proof");
  } } });
  const { domain } = await interrupted.add("a", external("resume.example.com"));
  f.txt.set(domain.challenge.name, [[domain.challenge.value]]);
  await assert.rejects(verify(interrupted, "a", domain), /durable DNS proof/);
  assert.equal(await f.routes.getHostname(domain.hostname), undefined);
  const stored = (await interrupted.list("a")).domains[0];
  assert.equal(stored.state, "verified");
  assert.equal((await verify(f.start({ ingress }), "a", stored)).state, "active");
  assert.equal(lookups, 1);
});

test("holds four DNS permits and cancellation cannot resurrect a removed domain", async () => {
  let release, started;
  const lookup = new Promise(resolve => { release = resolve; });
  const four = new Promise(resolve => { started = resolve; });
  const texts = new Map();
  let inFlight = 0;
  const f = fixture(), c = f.start({
    ingress: { externalTarget: "http://127.0.0.1:3200", dns: { resolveTxt: async name => {
      if (++inFlight === 4) started();
      await lookup;
      return [[texts.get(name)]];
    } }, probe: async () => true },
  });
  const domains = [];
  for (let i = 0; i < 5; i++) {
    const projectId = `app-${i}`;
    const { domain } = await c.add(projectId, external(`site-${i}.example.com`));
    domains.push([projectId, domain]); texts.set(domain.challenge.name, domain.challenge.value);
  }
  const inProgress = Promise.allSettled(domains.slice(0, 4).map(args => verify(c, ...args)));
  await four;
  try {
    await assert.rejects(verify(c, ...domains[4]), tagged("domain_verification_busy"));
    const [id] = domains[0];
    const during = (await c.list(id)).domains[0];
    await c.remove(id, during.hostname, during.revision);
  } finally {
    release();
  }
  const results = await inProgress;
  assert.equal(results[0].status, "rejected");
  assert.equal(await f.routes.getHostname(domains[0][1].hostname), undefined);
  assert.ok(results.slice(1).every(result => result.status === "fulfilled"));
});

test("resumes managed activation and withdrawal only after Edge acknowledgement", async () => {
  const f = fixture();
  let failApply = false, failOrder = true, probe = false, withdrawn = false, orders = 0;
  const capabilities = ["http", "https", "certificate-hot-reload", "websocket", "sse"];
  const adapter = {
    id: "traefik", title: "Edge fixture", capabilities,
    detect: async () => ({ state: "available", installed: true, healthy: true, detail: "active" }),
    stage: async () => {},
    verify: async () => ({ ready: true }),
    activate: async () => { if (failApply) throw new Error("injected activation failure"); },
    rollback: async () => {},
  };
  const manager = createZelavisEdgeManager({
    store: f.store, adapters: [adapter], defaultAdapterId: adapter.id,
    certificates: { stage: async () => {}, activate: async () => {}, rollback: async () => {} },
    getPublication: async () => {
      const pub = await f.routes.getCurrentPublication();
      return pub && { id: "zelavis-edge-routes", revision: String(pub.revision), routeCount: pub.routeCount };
    },
  });
  await Effect.runPromise(ensureProductionEdge({ routes: f.routes, manager, port: 3200 }));
  let saved;
  const certificates = {
    getCertificate: async () => saved,
    orderCertificate: async ({ hostname }) => {
      orders++;
      if (failOrder) throw new Error("injected issuance failure");
      return saved = { ref: `certificate:${hostname}`, hostname, status: "valid", expiresAt: new Date(Date.now() + 86400000).toISOString() };
    },
    retireProjectCertificate: async () => { saved = undefined; },
  };
  const restart = () => f.start({
    manager, certificates, ingress: { dns: { resolveTxt: async name => f.txt.get(name) ?? [] },
      preflight: async () => true, probe: async () => probe, probeWithdrawal: async () => withdrawn },
  });
  let controller = restart();
  const { domain } = await controller.add("a", { hostname: "secure.example.com", tlsMode: "managed" });
  f.txt.set(domain.challenge.name, [[domain.challenge.value]]);
  let result = await verify(controller, "a", domain);
  assert.equal(result.state, "verified");
  assert.equal(result.issue, "certificate_pending");
  assert.equal((await f.routes.getHostname(domain.hostname)).projectDomain.routing, "blocked");
  failOrder = false;
  failApply = true;
  controller = restart();
  result = await verify(controller, "a", result);
  assert.equal(result.state, "publishing");
  assert.equal(result.publicUrl, undefined);
  assert.equal((await f.routes.getHostname(domain.hostname)).projectDomain.routing, "blocked");
  assert.notEqual((await manager.getPolicy()).activePublication.revision, String((await f.routes.getCurrentPublication()).revision));
  failApply = false;
  result = await verify(restart(), "a", result);
  assert.equal(result.state, "publishing", "the fixed listener still needs to answer the probe");
  probe = true;
  result = await verify(restart(), "a", result);
  assert.equal(result.state, "active");
  assert.equal(orders, 2, "the persisted valid certificate is reused");
  const publication = await f.routes.getCurrentPublication();
  assert.equal(publication.routes.find(route => route.projectId === "a").targets[0].url, "http://127.0.0.1:3200");
  assert.deepEqual(publication.certificateRefs, [saved.ref]);
  failApply = true;
  assert.deepEqual(await controller.remove("a", result.hostname, result.revision), { removed: false, pending: true });
  assert.equal((await f.routes.getHostname(domain.hostname)).projectDomain.routing, "blocked");
  await assert.rejects(controller.add("b", external(domain.hostname)), tagged("hostname_unavailable"));
  let removing = (await controller.list("a")).domains[0];
  failApply = false;
  assert.deepEqual(await restart().remove("a", removing.hostname, removing.revision), { removed: false, pending: true });
  assert.equal((await f.routes.getHostname(domain.hostname)).projectDomain.routing, "blocked");
  removing = (await controller.list("a")).domains[0];
  withdrawn = true;
  assert.deepEqual(await restart().remove("a", removing.hostname, removing.revision), { removed: true, pending: false });
  assert.equal(await f.routes.getHostname(domain.hostname), undefined);
  assert.equal((await f.routes.getCurrentPublication()).routes.some(route => route.projectId === "a"), false);
  assert.equal(saved, undefined);
});

test("HTTP, SDK and CLI use the exact Project grant and Project deletion withdraws its domain", async t => {
  const store = createMemorySystemStore(), txt = new Map();
  const routes = createZelavisEdgeRouteStore({ store });
  let lookup;
  const p = await platform(t, {
    systemStore: store, edgeRoutes: routes,
    projectDomainIngress: { externalTarget: "http://127.0.0.1:3200", dns: { resolveTxt: async name => {
      if (lookup?.name === name) { lookup.start(); await lookup.pause; }
      return txt.get(name) ?? [];
    } }, probe: async () => true },
    serviceRegistry: { catalog: [{
      service: { name: "@test/app", version: "1.0.0", kind: "app", project: { runtimeKinds: ["native"] } },
      source: "official", status: "installed", specifier: "@test/app",
    }] },
    projectRuntime: {
      name: "test", runtimeKinds: ["native"], capabilities: () => ({ statelessRuntimeReplicas: false }),
      prepare: () => undefined, start: () => ({ status: "running", url: "http://127.0.0.1:1" }),
      status: () => ({ status: "stopped" }), stop: () => ({ status: "stopped" }),
      destroy: () => undefined, logs: () => [], close: () => undefined,
    },
  });
  for (const id of ["alpha", "beta"]) await p.client.projects.create({ id, name: id, recipeName: "@test/app", start: false });
  const stamp = new Date().toISOString();
  await routes.putHostname({ host: "panel.example.com", scope: "platform", tlsMode: "external", createdAt: stamp, updatedAt: stamp });
  const cli = (...args) => p.cli(async commandArgs => {
    const captured = console.log;
    console.log = (...parts) => { if (!parts.some(part => String(part).includes("Project domain operation"))) captured(...parts); };
    try { await runProjectsCommand(commandArgs); } finally { console.log = captured; }
  }, args);
  const base = "/runtime/projects/alpha/domains";
  p.as(undefined);
  await assert.rejects(p.send("POST", base, external("example.com")), { status: 401 });
  p.as({ id: "viewer", type: "user", grants: [scoped("project.domains.view", "alpha")] });
  assert.deepEqual(await p.client.projects.domains("alpha"), { domains: [] });
  await assert.rejects(p.client.projects.addDomain("alpha", external("example.com")), { status: 403 });
  const customer = { id: "customer", type: "user", roles: ["customer"], grants: [scoped("project.domains.manage", "alpha")] };
  p.as(customer);
  await assert.rejects(p.client.projects.get("alpha"), { status: 403 });
  await assert.rejects(p.client.projects.domains("beta"), { status: 403 });
  await assert.rejects(p.send("GET", "/runtime/edge/routes"), { status: 403 });
  await assert.rejects(p.send("POST", "/runtime/edge/publish", {}), { status: 403 });
  await assert.rejects(p.send("POST", base, { ...external("example.com"), target: "http://127.0.0.1:1" }), tagged("invalid_domain_request"));
  await assert.rejects(p.send("POST", base, external("panel.example.com")), tagged("hostname_unavailable"));
  await assert.rejects(cli("domains", "beta"), { status: 403 });
  const added = await cli("add-domain", "alpha", "example.com", "--tls", "external");
  assert.deepEqual(await p.send("GET", base), { domains: [added] });
  assert.deepEqual(await cli("domains", "alpha"), { domains: [added] });
  assert.deepEqual(await p.client.projects.addDomain("alpha", external("EXAMPLE.COM.")), added);
  txt.set(added.challenge.name, [[added.challenge.value]]);
  const active = await cli("verify-domain", "alpha", added.hostname, "--revision", String(added.revision));
  assert.equal(active.publicUrl, "https://example.com/");
  assert.equal((await p.through("https://example.com/")).status, 503);
  for (const hostname of ["example.com", "example.com.", "example.com.."]) {
    assert.equal((await p.through(`https://${hostname}/zelavis/api/v1/runtime/projects`)).status, 404);
  }
  assert.deepEqual(await cli("remove-domain", "alpha", active.hostname, "--revision", String(active.revision)), { removed: true, pending: false });
  assert.deepEqual(await p.client.projects.removeDomain("alpha", active.hostname, active.revision), { removed: false, pending: false });
  const next = await p.client.projects.addDomain("alpha", external("app.example.com"));
  txt.set(next.challenge.name, [[next.challenge.value]]);
  await p.client.projects.verifyDomain("alpha", next.hostname, { expectedRevision: next.revision });
  assert.equal((await routes.listRoutes({ projectId: "alpha" })).length, 1);
  assert.equal((await routes.compile()).routes.some(route => route.projectId === "alpha"), false,
    "the external terminator publishes its own TLS configuration");
  const late = await p.client.projects.addDomain("alpha", external("late.example.com"));
  txt.set(late.challenge.name, [[late.challenge.value]]);
  let release, start;
  const started = new Promise(resolve => { start = resolve; });
  lookup = { name: late.challenge.name, start, pause: new Promise(resolve => { release = resolve; }) };
  const verification = assert.rejects(p.client.projects.verifyDomain("alpha", late.hostname, { expectedRevision: late.revision }),
    tagged("domain_not_found"));
  await started;
  try {
    p.as({ id: "owner", type: "user", permissions: ["*"] });
    await p.client.projects.remove("alpha");
  } finally {
    release();
  }
  await verification;
  assert.equal(await routes.getHostname(late.hostname), undefined);
  assert.equal(await routes.getHostname(next.hostname), undefined);
  assert.equal((await routes.listRoutes({ projectId: "alpha" })).length, 0);
  assert.equal((await routes.getHostname("panel.example.com")).scope, "platform");
});
