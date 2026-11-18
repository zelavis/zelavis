import assert from "node:assert/strict";
import test from "node:test";
import { createAuthoritativeDnsTxtResolver } from "../dist/adapters/_node-authoritative-dns.js";
import { startDnsAuthority } from "./_dns-authority.mjs";

const challenge = "_zelavis-challenge.shop.example.com";
const txt = (...strings) => ({ type: "TXT", strings });
const zone = (ns, records = [], extra = {}) => ({ ns, records: new Map(records), ...extra });
const resolverFor = (fixture, options = {}) =>
  createAuthoritativeDnsTxtResolver({ recursiveServers: [fixture.address], authoritativePort: fixture.port, ...options });
const coded = code => error => { assert.equal(error.code, code, error.message); return true; };
const txtQueries = (fixture, name) => fixture.queries.filter(query => query.name === name && query.type === "TXT");

test("a record added after a failed check is read at once, past the recursive negative cache", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com", "ns2.example.com"])]]) });
  const resolver = resolverFor(fixture);
  assert.deepEqual(await resolver.resolveTxt(challenge), []);
  fixture.set(challenge, "TXT", [txt("token-", "value")]);
  assert.deepEqual(await resolver.resolveTxt(challenge), [["token-", "value"]]);
  assert.deepEqual(txtQueries(fixture, challenge).map(query => query.rd), [false, false]);
  // The recursive side still holds the negative answer: only the authority saw the new record.
  assert.ok(fixture.queries.some(query => query.name === challenge && query.type === "SOA" && query.rd));
});

test("a hostname whose address is a CNAME into another zone is checked in its own zone", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([
    ["example.com", zone(["ns1.example.com"], [["shop.example.com|CNAME", [{ type: "CNAME", target: "ingress.host.net" }]],
      [`${challenge}|TXT`, [txt("token")]]])],
    ["host.net", zone(["ns1.host.net"], [["ingress.host.net|A", [{ type: "A", address: "192.0.2.1" }]]])],
  ]) });
  assert.deepEqual(await resolverFor(fixture).resolveTxt(challenge), [["token"]]);
  assert.ok(!fixture.queries.some(query => query.name === "host.net" || query.name.endsWith(".host.net")));
});

test("a delegated child zone is found from the challenge's own SOA", async t => {
  const name = "_zelavis-challenge.app.eu.example.com";
  const fixture = await startDnsAuthority(t, { zones: new Map([
    ["example.com", zone(["ns1.example.com"])],
    ["eu.example.com", zone(["ns1.eu.example.com"], [[`${name}|TXT`, [txt("child-token")]]])],
  ]) });
  assert.deepEqual(await resolverFor(fixture).resolveTxt(name), [["child-token"]]);
  assert.ok(fixture.queries.some(query => query.name === "eu.example.com" && query.type === "NS"));
  assert.ok(!fixture.queries.some(query => query.name === "example.com" && query.type === "NS"));
});

test("a CNAME at the challenge name is refused", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"],
    [[`${challenge}|CNAME`, [{ type: "CNAME", target: "verify.provider.example.com" }]],
      ["verify.provider.example.com|TXT", [txt("token")]]])]]) });
  await assert.rejects(resolverFor(fixture).resolveTxt(challenge), coded("ECNAME"));
});

test("a CNAME the authority reports, though discovery did not see one, is refused", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"])]]) });
  const resolver = resolverFor(fixture);
  assert.deepEqual(await resolver.resolveTxt(challenge), []);
  // The recursive side cached the negative SOA answer; the authority now has a CNAME there.
  fixture.set(challenge, "CNAME", [{ type: "CNAME", target: "verify.example.com" }]);
  await assert.rejects(resolver.resolveTxt(challenge), coded("ECNAME"));
});

test("an answer without the authoritative flag decides nothing", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com",
    zone(["ns1.example.com"], [[`${challenge}|TXT`, [txt("token")]]], { authoritative: false })]]) });
  await assert.rejects(resolverFor(fixture).resolveTxt(challenge), coded("ESERVFAIL"));
});

test("silent authorities time out within the per-query bound", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com", "ns2.example.com"])]]) });
  fixture.dropAuthoritative(true);
  const started = Date.now();
  await assert.rejects(resolverFor(fixture, { queryTimeoutMs: 200 }).resolveTxt(challenge), coded("ESERVFAIL"));
  assert.ok(Date.now() - started < 2000);
  // Both nameservers resolve to the one fixture address, which is asked once.
  assert.equal(txtQueries(fixture, challenge).length, 1);
});

test("unparsable recursive servers are skipped, and an unreachable one fails as unavailable", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"])]]) });
  const resolver = createAuthoritativeDnsTxtResolver({ recursiveServers: [`127.0.0.1:${fixture.port}`, "not-an-address"],
    authoritativePort: fixture.port, queryTimeoutMs: 200 });
  assert.deepEqual(await resolver.resolveTxt(challenge), []);
  await assert.rejects(createAuthoritativeDnsTxtResolver({ recursiveServers: ["bogus"] }).resolveTxt(challenge), coded("ESERVFAIL"));
  await assert.rejects(createAuthoritativeDnsTxtResolver({ recursiveServers: ["127.0.0.1:1"], queryTimeoutMs: 500 })
    .resolveTxt(challenge), coded("ESERVFAIL"));
});

test("a truncated UDP answer is asked again over TCP", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"], [[`${challenge}|TXT`, [txt("token")]]])]]) });
  fixture.truncateAuthoritative(true);
  assert.deepEqual(await resolverFor(fixture).resolveTxt(challenge), [["token"]]);
  assert.deepEqual(txtQueries(fixture, challenge).map(query => query.transport), ["udp", "tcp"]);
});

test("a name in no zone is not found, and the result never comes from the recursive side", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"])]]) });
  await assert.rejects(resolverFor(fixture).resolveTxt("_zelavis-challenge.shop.example.org"), coded("ENOTFOUND"));
  assert.equal(fixture.queries.filter(query => query.type === "TXT" && query.rd).length, 0);
});

test("an aborted signal ends the lookup promptly and leaves no socket open", async t => {
  const fixture = await startDnsAuthority(t, { zones: new Map([["example.com", zone(["ns1.example.com"])]]) });
  fixture.dropAuthoritative(true);
  const resolver = resolverFor(fixture, { queryTimeoutMs: 10_000 });
  await assert.rejects(resolver.resolveTxt(challenge, AbortSignal.abort()), coded("ETIMEOUT"));
  const started = Date.now();
  await assert.rejects(resolver.resolveTxt(challenge, AbortSignal.timeout(100)), coded("ETIMEOUT"));
  assert.ok(Date.now() - started < 2000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === "UDPWrap").length, 1); // the fixture's own socket
});
