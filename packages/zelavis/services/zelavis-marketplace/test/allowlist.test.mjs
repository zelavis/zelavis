import assert from "node:assert/strict";
import test from "node:test";

import {
  AllowlistRefusal,
  allowlistCatalogEntries,
  createAllowlistClient,
  createAllowlistGate,
  parseAllowlist,
} from "../dist/allowlist/index.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const OTHER_INTEGRITY = `sha512-${"B".repeat(86)}==`;
const NOW = Date.parse("2026-06-01T00:00:00Z");

function list(overrides = {}) {
  return {
    schemaVersion: 1,
    sequence: 5,
    issuedAt: "2026-05-30T00:00:00Z",
    expiresAt: "2026-07-01T00:00:00Z",
    services: [{
      name: "@zelavis/wordpress", kind: "app", maintainer: "zelavis", title: "WordPress",
      summary: "A managed WordPress site.", categories: ["apps", "cms"], runtimeKinds: ["native"],
      versions: [{ version: "7.1.0", integrity: INTEGRITY, platform: "2.0.0" }, { version: "7.0.0", integrity: OTHER_INTEGRITY, platform: "1.0.0", deprecated: "old" }],
      latest: "7.1.0",
    }],
    ...overrides,
  };
}

test("a served list is accepted as plain JSON, and anything else is not", async () => {
  const fetcher = source({ "https://zelavis.example/allowlist.json": list() });
  const client = createAllowlistClient({ sources: ["https://zelavis.example/allowlist.json"], cache: memoryCache(), fetch: fetcher, now: () => NOW });
  const report = await client.refresh();
  assert.equal(report.updated, true);
  assert.equal(report.view.allowlist.services[0].name, "@zelavis/wordpress");
  for (const bad of [null, [], "x", {}, { ...list(), services: "x" }]) {
    const refused = await createAllowlistClient({ sources: ["https://zelavis.example/x"], cache: memoryCache(), fetch: source({ "https://zelavis.example/x": bad }), now: () => NOW }).refresh();
    assert.equal(refused.updated, false, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("the list itself is validated strictly", () => {
  assert.doesNotThrow(() => parseAllowlist(list()));
  const service = list().services[0];
  const bad = [
    list({ schemaVersion: 2 }),
    list({ sequence: 0 }),
    list({ sequence: 1.5 }),
    list({ expiresAt: "2026-05-01T00:00:00Z" }),
    list({ services: [service, service] }),
    list({ services: [{ ...service, name: "../evil" }] }),
    list({ services: [{ ...service, kind: "core" }] }),
    list({ services: [{ ...service, latest: "9.9.9" }] }),
    list({ services: [{ ...service, versions: [] }] }),
    list({ services: [{ ...service, versions: [{ version: "^7.0.0", integrity: INTEGRITY, platform: "2.0.0" }], latest: "^7.0.0" }] }),
    list({ services: [{ ...service, versions: [{ version: "7.1.0", integrity: "sha1-abc", platform: "2.0.0" }] }] }),
    list({ services: [{ ...service, versions: [{ version: "7.1.0", integrity: INTEGRITY }] }] }),
    list({ services: [{ ...service, versions: [{ version: "7.1.0", integrity: INTEGRITY, platform: ">=2.0.0" }] }] }),
    list({ services: [{ ...service, title: "two\nlines" }] }),
    "not an object",
  ];
  for (const input of bad) assert.throws(() => parseAllowlist(input), /allow-list|must|repeats|one of|npm package name/i);
});

function source(map) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), redirect: init.redirect });
    const value = map[String(url)];
    if (value instanceof Error) throw value;
    if (value === undefined) return new Response("no", { status: 503 });
    return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
  };
  fetcher.calls = calls;
  return fetcher;
}

function memoryCache() {
  let value;
  return { read: () => value, write: (next) => { value = next; }, get value() { return value; }, set value(next) { value = next; } };
}

test("any reachable source is enough, and the first one that is newer wins", async () => {
  const good = list({ sequence: 7 });
  const fetcher = source({
    "https://zelavis.example/allowlist.json": new Error("connect ECONNREFUSED"),
    "https://gist.example/allowlist.json": good,
  });
  const cache = memoryCache();
  const client = createAllowlistClient({
    sources: ["https://zelavis.example/allowlist.json", "https://gist.example/allowlist.json", "https://third.example/a.json"],
    cache, fetch: fetcher, now: () => NOW,
  });
  const report = await client.refresh();
  assert.equal(report.updated, true);
  assert.deepEqual(report.attempts.map((a) => a.outcome), ["unreachable", "ok"]);
  assert.equal(fetcher.calls.length, 2, "it stops at the first acceptable list");
  assert.ok(fetcher.calls.every((call) => call.redirect === "error"), "a redirect is somewhere nobody named");
  assert.equal(report.view.allowlist.sequence, 7);
  assert.equal(cache.value.source, "https://gist.example/allowlist.json");
  assert.equal((await client.current()).origin, "cache");
});

test("a source cannot move an installation backwards", async () => {
  const held = parseAllowlist(list({ sequence: 9 }));
  const cache = memoryCache();
  cache.value = { allowlist: held, source: "https://zelavis.example/a.json", fetchedAt: "2026-05-31T00:00:00Z" };
  // Well formed, but older: a replay of a list from before a service was removed.
  const replay = list({ sequence: 4 });
  const fetcher = source({ "https://mirror.example/a.json": replay });
  const client = createAllowlistClient({ sources: ["https://mirror.example/a.json"], cache, fetch: fetcher, now: () => NOW });
  const report = await client.refresh();
  assert.equal(report.updated, false);
  assert.equal(report.attempts[0].outcome, "stale");
  assert.equal((await client.current()).allowlist.sequence, 9);

  // The release's own list is a floor too.
  const bundledClient = createAllowlistClient({
    sources: ["https://mirror.example/a.json"], cache: memoryCache(),
    bundled: parseAllowlist(list({ sequence: 20 })), fetch: fetcher, now: () => NOW,
  });
  assert.equal((await bundledClient.refresh()).attempts[0].outcome, "stale");
});

test("malformed, expired, oversized and non-https sources are all skipped", async () => {
  const expired = list({ sequence: 50, issuedAt: "2025-01-01T00:00:00Z", expiresAt: "2025-02-01T00:00:00Z" });
  const fetcher = source({
    "https://a.example/x": { ...list({ sequence: 99 }), services: "forged" },
    "https://b.example/x": { schemaVersion: 1, sequence: 100, services: [] },
    "https://c.example/x": expired,
    "https://d.example/x": "x".repeat(2 * 1024 * 1024),
    "https://e.example/x": "not json",
  });
  const client = createAllowlistClient({
    sources: ["https://a.example/x", "https://b.example/x", "https://c.example/x", "https://d.example/x", "https://e.example/x", "http://plain.example/x"],
    cache: memoryCache(), fetch: fetcher, now: () => NOW,
  });
  const report = await client.refresh();
  assert.equal(report.updated, false);
  assert.deepEqual(report.attempts.map((a) => a.outcome), ["invalid", "invalid", "expired", "unreachable", "unreachable", "unreachable"]);
  assert.equal(await client.current(), undefined, "nothing trusted is held");
  assert.ok(!fetcher.calls.some((call) => call.url.startsWith("http://")), "plain http is never fetched");
});

test("what is held survives an outage, is checked again on every read, and ages out", async () => {
  const held = parseAllowlist(list({ sequence: 3 }));
  const cache = memoryCache();
  cache.value = { allowlist: held, source: "https://zelavis.example/a.json", fetchedAt: "2026-05-31T00:00:00Z" };
  let now = NOW;
  const down = source({});
  const client = createAllowlistClient({ sources: ["https://zelavis.example/a.json"], cache, fetch: down, now: () => now });
  assert.equal((await client.current()).status, "fresh");
  assert.equal((await client.refresh()).updated, false);
  assert.equal((await client.current()).allowlist.sequence, 3, "an outage changes nothing");

  now = Date.parse("2026-07-03T00:00:00Z");
  assert.equal((await client.current()).status, "stale");
  now = Date.parse("2026-08-01T00:00:00Z");
  assert.equal((await client.current()).status, "expired");

  // Someone edits the cache file.
  now = NOW;
  cache.value = { ...cache.value, allowlist: { ...held, sequence: 0 } };
  assert.equal(await client.current(), undefined);
});

test("the gate vouches only for listed versions with the listed digest", async () => {
  const client = createAllowlistClient({
    sources: [], cache: memoryCache(), bundled: parseAllowlist(list()), now: () => NOW,
  });
  const gate = createAllowlistGate(client, { platform: "2.0.0" });
  const ok = await gate.authorize({ name: "@zelavis/wordpress", version: "7.1.0" });
  assert.equal(ok.service.maintainer, "zelavis");
  await gate.verifyAcquired({ name: "@zelavis/wordpress", version: "7.1.0", integrity: INTEGRITY });

  const refusal = (promise, code) =>
    assert.rejects(promise, (error) => error instanceof AllowlistRefusal && error.code === code);
  await refusal(gate.authorize({ name: "@evil/thing", version: "1.0.0" }), "not_listed");
  await refusal(gate.authorize({ name: "@zelavis/wordpress", version: "7.2.0" }), "version_not_listed");
  await refusal(gate.authorize({ name: "@zelavis/wordpress", version: "latest" }), "version_not_listed");
  await refusal(gate.verifyAcquired({ name: "@zelavis/wordpress", version: "7.1.0", integrity: OTHER_INTEGRITY }), "digest_mismatch");

  const none = createAllowlistGate(createAllowlistClient({ sources: [], now: () => NOW }), { platform: "2.0.0" });
  await refusal(none.authorize({ name: "@zelavis/wordpress", version: "7.1.0" }), "unavailable");
  const late = createAllowlistGate(createAllowlistClient({
    sources: [], bundled: parseAllowlist(list()), now: () => Date.parse("2026-07-03T00:00:00Z"),
  }), { platform: "2.0.0" });
  await refusal(late.authorize({ name: "@zelavis/wordpress", version: "7.1.0" }), "expired");
});

test("the catalogue offers each service at its latest exact version", () => {
  const [entry] = allowlistCatalogEntries(parseAllowlist(list()).services, "2.0.0");
  assert.equal(entry.specifier, "npm:@zelavis/wordpress@7.1.0");
  assert.equal(entry.status, "available");
  assert.equal(entry.source, "community", "the registry reserves official for what the host bundled");
  assert.equal(entry.maintainer, "zelavis");
  assert.equal(entry.service.marketplace.title, "WordPress");
  assert.deepEqual(entry.service.project, { runtimeKinds: ["native"] });
});


test("managed recipe metadata survives parsing and catalogue publication; invalid declarations are refused", () => {
  const service = { ...list().services[0], managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } };
  const parsed = parseAllowlist(list({ services: [service] }));
  assert.deepEqual(allowlistCatalogEntries(parsed.services, "2.0.0")[0].service.project.managed, service.managed);
  for (const managed of [null, true, [], { adminPath: "http://localhost" }, { adminPath: "/../private" }, { unexpected: true }])
    assert.throws(() => parseAllowlist(list({ services: [{ ...service, managed }] })), /managed/);
  assert.throws(() => parseAllowlist(list({ services: [{ ...service, kind: "plugin" }] })), /only for Project recipes/);
});

test("an older Platform is offered, and may install, only what it runs", async () => {
  const service = {
    ...list().services[0],
    versions: [
      { version: "7.2.0", integrity: INTEGRITY, platform: "2.0.0-alpha.40" },
      { version: "7.1.0", integrity: OTHER_INTEGRITY, platform: "2.0.0-alpha.9" },
      { version: "7.0.5", integrity: OTHER_INTEGRITY, platform: "2.0.0-alpha.3", deprecated: "broken" },
      { version: "7.0.0", integrity: OTHER_INTEGRITY, platform: "2.0.0-alpha.1" },
    ],
    latest: "7.2.0",
  };
  const parsed = parseAllowlist(list({ services: [service] }));
  const offered = (platform) => allowlistCatalogEntries(parsed.services, platform)[0].service.version;
  assert.equal(offered("2.0.0-alpha.40"), "7.2.0");
  assert.equal(offered("2.0.0"), "7.2.0", "a stable release runs what its prereleases ran");
  assert.equal(offered("2.0.0-alpha.39"), "7.1.0", "the newest version this Platform runs, by numeric prerelease order");
  assert.equal(offered("2.0.0-alpha.8"), "7.0.0", "a deprecated version is not offered");
  assert.equal(offered("1.9.0"), "7.2.0", "listed so it is found; the gate says what it needs");
  assert.equal(allowlistCatalogEntries(parsed.services, "2.0.0-alpha.39")[0].specifier, "npm:@zelavis/wordpress@7.1.0");

  const gate = createAllowlistGate(createAllowlistClient({ sources: [], bundled: parsed, now: () => NOW }), { platform: "2.0.0-alpha.39" });
  await gate.authorize({ name: "@zelavis/wordpress", version: "7.1.0" });
  await assert.rejects(gate.authorize({ name: "@zelavis/wordpress", version: "7.2.0" }), (error) =>
    error instanceof AllowlistRefusal && error.code === "platform_too_old"
      && /needs Zelavis 2\.0\.0-alpha\.40 or newer, and this Platform runs 2\.0\.0-alpha\.39\. Update Zelavis first/.test(error.message));
});
