import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore } from "../dist/system-store.js";
import { collectRegistrars } from "../dist/edge/registrar-provider.js";
import { createRegistrarController, REGISTRAR_CONNECTION, REGISTRAR_CONTACTS } from "../dist/edge/registrar.js";
import { fakeRegistrar, contact } from "./_registrar-fake.mjs";
const secret = "registrar-test-master-secret-0123456789";
export const setup = (extra = {}) => {
  const fake = extra.fake ?? fakeRegistrar(); const store = extra.store ?? createMemorySystemStore();
  const registrar = createRegistrarController({ store, masterSecret: secret, providers: [{ definition: fake.definition, source: "plugin", plugin: fake.plugin.name }], ...extra });
  return { fake, store, registrar };
};
const connect = registrar => registrar.connect({ provider: "fake", sandbox: true, credentials: { token: "test-secret" } });
test("registrar discovery reserves built-in identities and ignores unavailable plugins", () => {
  const fake = fakeRegistrar(); const entry = { status: "installed", service: fake.plugin };
  const result = collectRegistrars([entry], [fake.definition]); assert.equal(result.providers.length, 1); assert.equal(result.refused[0].code, "registrar_conflict");
  assert.equal(collectRegistrars([{ ...entry, status: "available" }]).providers.length, 0);
});
test("connection and contacts are validated, encrypted and revised; credentials never returned", async () => {
  const { registrar, store } = setup();
  await assert.rejects(registrar.connect({ provider: "fake", sandbox: true, credentials: { token: "bad" } }), e => e.code === "registrar_failed" && !e.message.includes("test-secret"));
  await connect(registrar);
  assert.deepEqual(await registrar.connection(), { provider: "fake", sandbox: true, connected: true, revision: 1 });
  assert.ok(!JSON.stringify(await store.get(REGISTRAR_CONNECTION, "current")).includes("test-secret"));
  await registrar.setContact({ contact, expectedRevision: 0 });
  assert.deepEqual(await registrar.contact(), { contact, revision: 1 });
  assert.ok(!JSON.stringify(await store.get(REGISTRAR_CONTACTS, "default")).includes(contact.email));
  await assert.rejects(registrar.setContact({ contact, expectedRevision: 0 }), e => e.code === "invalid_registrar_request");
  await assert.rejects(registrar.setContact({ contact: { ...contact, country: "USA" } }), e => e.code === "invalid_registrar_request");
  await registrar.disconnect(); assert.deepEqual(await registrar.connection(), { connected: false, revision: 0 });
});

const orderInput = (overrides = {}) => ({ kind: "register", domain: "example.com", years: 1, confirm: { amount: "10.0000", currency: "USD", years: 1 }, idempotencyKey: "order-key-0001", ...overrides });
const ready = async (extra = {}) => { const result = setup(extra); await connect(result.registrar); await result.registrar.setContact({ contact }); return result; };

test("orders use immutable idempotency keys and fresh prices; stale prices buy nothing", async () => {
  const { registrar, fake, store } = await ready();
  const first = await registrar.order(orderInput(), "owner"); assert.equal(first.created, true); assert.equal(first.order.state, "completed");
  const repeat = await registrar.order(orderInput(), "owner"); assert.equal(repeat.created, false); assert.deepEqual(repeat.order, first.order);
  assert.equal(fake.state.calls.length, 1);
  await assert.rejects(registrar.order(orderInput({ domain: "different.com" }), "owner"), e => e.code === "invalid_registrar_request");
  fake.state.price.amount = "12.0000";
  await assert.rejects(registrar.order(orderInput({ domain: "different.com", idempotencyKey: "stale-key-0001" }), "owner"), e => e.code === "price_changed" && e.price.amount === "12.0000");
  assert.equal(fake.state.calls.length, 1); assert.equal(await store.get("registrar.order-keys", "stale-key-0001"), undefined);
  assert.equal((await registrar.orders({ limit: 1 })).orders.length, 1);
  assert.equal((await registrar.getOrder(first.order.id)).id, first.order.id);
});

test("ambiguous register is never submitted again; reconciliation confirms ownership or absence", async () => {
  const { registrar, fake } = await ready();
  fake.state.submit = async () => { throw new Error("network failure test-secret owner@example.com"); };
  const first = await registrar.order(orderInput(), "owner"); assert.equal(first.order.state, "unknown");
  await assert.rejects(registrar.connect({ provider: "fake", sandbox: true, credentials: { token: "test-secret" } }), e => e.code === "registrar_busy");
  await assert.rejects(registrar.disconnect(), e => e.code === "registrar_busy");
  await assert.rejects(registrar.order(orderInput({ idempotencyKey: "different-key" }), "owner"), e => e.code === "registrar_busy");
  fake.state.owned.set("example.com", "2027-11-16T00:00:00.000Z");
  await registrar.reconcile(); assert.equal((await registrar.getOrder(first.order.id)).state, "completed"); assert.equal(fake.state.calls.length, 1);
  const second = await registrar.order(orderInput({ domain: "not-bought.com", idempotencyKey: "absent-key-0001" }), "owner");
  await registrar.reconcile(); assert.equal((await registrar.getOrder(second.order.id)).state, "failed"); assert.equal(fake.state.calls.length, 2);
});

test("restart after a lost receipt reconciles submitting without a second create", async () => {
  const store = createMemorySystemStore(); const originalCas = store.compareAndSet;
  let loseReceipt = true;
  store.compareAndSet = (...args) => {
    if (loseReceipt && args[0] === "registrar.orders" && args[3].state === "completed") throw new Error("simulated crash before receipt persistence");
    return originalCas(...args);
  };
  const { registrar, fake } = await ready({ store });
  await assert.rejects(registrar.order(orderInput(), "owner"), /simulated crash/);
  const [row] = await store.list("registrar.orders"); assert.equal(row.value.state, "submitting");
  await registrar.close(); loseReceipt = false;
  const restarted = setup({ store, fake }).registrar;
  await restarted.reconcile(); assert.equal((await restarted.getOrder(row.key)).state, "completed");
  assert.equal((await restarted.order(orderInput(), "owner")).order.state, "completed"); assert.equal(fake.state.calls.length, 1);
});

test("connection close aborts a submission and leaves one unknown order, then restart reconciles", async () => {
  const { registrar, fake, store } = await ready({ submitTimeoutMs: 30 });
  let started; const entered = new Promise(resolve => { started = resolve; });
  fake.state.submit = (_input, context) => new Promise((_resolve, reject) => { started(); context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
  const pending = registrar.order(orderInput(), "owner"); await entered;
  await assert.rejects(registrar.order(orderInput({ idempotencyKey: "concurrent-key" }), "owner"), e => e.code === "registrar_busy");
  await registrar.close(); assert.equal((await pending).order.state, "unknown");
  const restarted = setup({ store, fake }).registrar;
  fake.state.owned.set("example.com", "2027-11-16T00:00:00.000Z");
  await restarted.reconcile(); assert.equal((await restarted.orders()).orders[0].state, "completed"); assert.equal(fake.state.calls.length, 1);
});

test("transfer polls status without storing auth code; ambiguous renewal uses the previous expiry", async () => {
  let time = Date.parse("2026-11-16T00:00:00.000Z");
  const { registrar, fake, store } = await ready({ now: () => new Date(time) });
  const transfer = await registrar.order(orderInput({ kind: "transfer", authCode: "private-epp-code" }), "owner"); assert.equal(transfer.order.state, "pending_transfer");
  assert.ok(!JSON.stringify(await store.list("registrar.orders")).includes("private-epp-code"));
  assert.ok(!JSON.stringify(await store.list("registrar.active-orders")).includes("private-epp-code"));
  await registrar.reconcile(); assert.equal((await registrar.getOrder(transfer.order.id)).state, "pending_transfer");
  fake.state.transfer = "completed"; time += 60_001;
  await registrar.reconcile(); assert.equal((await registrar.getOrder(transfer.order.id)).state, "completed");
  fake.state.owned.set("example.com", "2027-11-16T00:00:00.000Z"); fake.state.submit = async () => { throw new Error("lost"); };
  const renew = await registrar.order(orderInput({ kind: "renew", idempotencyKey: "renew-key-0001" }), "owner"); assert.equal(renew.order.state, "unknown");
  fake.state.owned.set("example.com", "2028-11-16T00:00:00.000Z"); await registrar.reconcile(); assert.equal((await registrar.getOrder(renew.order.id)).state, "completed");
});

test("active intent bridges the idempotency-index/order crash gap without submitting; corrupt state fails closed", async () => {
  const { registrar, store, fake } = await ready();
  const original = store.setIfAbsent;
  store.setIfAbsent = (...args) => { if (args[0] === "registrar.orders") throw new Error("crash in index gap"); return original(...args); };
  await assert.rejects(registrar.order(orderInput(), "owner"), /index gap/); store.setIfAbsent = original;
  await registrar.close(); const restarted = setup({ store, fake }).registrar;
  await restarted.reconcile(); assert.equal((await restarted.orders()).orders[0].state, "failed"); assert.equal(fake.state.calls.length, 0);
  const order = (await restarted.orders()).orders[0]; await store.set("registrar.orders", order.id, { bad: true });
  await assert.rejects(restarted.getOrder(order.id)); assert.equal(fake.state.calls.length, 0);
});

test("missing contact, invalid requests and unavailable domains never submit", async () => {
  const { registrar, fake } = setup(); await connect(registrar);
  await assert.rejects(registrar.order(orderInput(), "owner"), e => e.code === "registrar_contact_missing");
  for (const fields of [{ years: 11 }, { idempotencyKey: "short" }, { domain: "https://example.com" }, { authCode: "unneeded" }]) await assert.rejects(registrar.order(orderInput(fields), "owner"), e => e.code === "invalid_registrar_request");
  assert.equal(fake.state.calls.length, 0);
});

test("HTTP registrar authority is system-scoped, price-checked and Platform-only", async t => {
  const { platform } = await import("./_runtime.mjs"); const fake = fakeRegistrar(); const store = createMemorySystemStore();
  const p = await platform(t, { systemStore: store, edgeRegistrars: [fake.definition] });
  assert.equal((await p.send("GET", "/runtime/registrar/providers")).providers[0].source, "built-in");
  await p.send("PUT", "/runtime/registrar/connection", { provider: "fake", sandbox: true, credentials: { token: "test-secret" } });
  await p.send("PUT", "/runtime/registrar/contact", { contact, expectedRevision: 0 });
  assert.equal((await p.send("POST", "/runtime/registrar/availability", { domains: ["example.com"] })).domains[0].available, true);
  const price = await p.send("POST", "/runtime/registrar/quote", { domain: "example.com", kind: "register", years: 1 });
  assert.equal(price.amount, "10.0000");
  const submitted = await p.through("http://localhost/zelavis/api/v1/runtime/registrar/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(orderInput()) });
  assert.equal(submitted.status, 201);
  const first = await submitted.json();
  fake.state.price.amount = "12.0000";
  await assert.rejects(p.send("POST", "/runtime/registrar/orders", orderInput({ domain: "stale.com", idempotencyKey: "http-stale-price" })), error => error.status === 409 && error.body.code === "price_changed" && error.body.price.amount === "12.0000");
  assert.equal(fake.state.calls.length, 1);
  fake.state.price.amount = "10.0000";
  assert.equal(first.state, "completed"); assert.equal((await p.send("POST", "/runtime/registrar/orders", orderInput())).id, first.id);
  const response = await p.through(`http://localhost/zelavis/api/v1/runtime/registrar/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(orderInput()) }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  for (const [method, path, body] of [["POST", "/availability", { domains: Array(21).fill("example.com") }], ["POST", "/orders", { ...orderInput(), extra: true }], ["PUT", "/contact", { contact: { ...contact, phone: "bad" } }], ["PUT", "/domains/example.com/nameservers", { nameservers: ["ns1.example.com"] }]]) await assert.rejects(p.send(method, `/runtime/registrar${path}`, body), { status: 400 });
  await assert.rejects(p.send("GET", "/runtime/registrar/orders?limit=51"), { status: 400 });
  await p.send("PUT", "/runtime/registrar/domains/example.com/nameservers", { nameservers: ["ns1.example.com", "ns2.example.com"] });
  p.as({ id: "viewer", type: "user", grants: [{ permission: "server.domains.view", scope: { type: "system" } }] });
  assert.equal((await p.send("GET", "/runtime/registrar/orders")).orders.length, 1);
  for (const path of ["/connection", "/contact"]) await assert.rejects(p.send("GET", `/runtime/registrar${path}`), { status: 403 });
  await assert.rejects(p.send("POST", "/runtime/registrar/orders", orderInput()), { status: 403 });
  p.as({ id: "customer", type: "user", grants: [{ permission: "server.domains.purchase", scope: { type: "project", projectId: "alpha" } }, { permission: "server.domains.view", scope: { type: "project", projectId: "alpha" } }] });
  await assert.rejects(p.send("GET", "/runtime/registrar/orders"), { status: 403 });
  await assert.rejects(p.send("PUT", "/runtime/registrar/connection", { provider: "fake", sandbox: true, credentials: { token: "test-secret" } }), { status: 403 });
  p.as(undefined); await assert.rejects(p.send("GET", "/runtime/registrar/providers"), { status: 401 });
  const app = await platform(t, { role: "project", subsystems: { auth: false }, edgeRegistrars: [fake.definition] });
  await assert.rejects(app.send("GET", "/runtime/registrar/providers"), { status: 404 });
});

test("registrar SDK and CLI reach the same HTTP operations and preserve idempotency", async t => {
  const { platform, viaSdk, viaCli } = await import("./_runtime.mjs");
  const { runRegistrarCommand } = await import("../dist/cli/registrar-operations.js");
  const fake = fakeRegistrar(); const p = await platform(t, { edgeRegistrars: [fake.definition] });
  const quiet = async args => { const log = console.log; console.log = (...parts) => { if (!/^\[\d{2}:\d{2}/.test(String(parts[0]))) log(...parts); }; try { await runRegistrarCommand(args); } finally { console.log = log; } };
  await p.client.registrar.connect({ provider: "fake", sandbox: true, credentials: { token: "test-secret" } });
  await p.client.registrar.setContact({ contact });
  for (const [action, sdk] of [["providers", () => p.client.registrar.providers()], ["connection", () => p.client.registrar.connection()], ["contact", () => p.client.registrar.contact()], ["domains", () => p.client.registrar.domains()], ["orders", () => p.client.registrar.orders()]]) assert.deepEqual(await p.cli(quiet, [action]), await sdk());
  const result = await p.cli(quiet, ["order", "--data", JSON.stringify(orderInput())]); assert.equal(result.state, "completed");
  assert.deepEqual(await p.client.registrar.order(orderInput()), result); assert.equal(fake.state.calls.length, 1);
  assert.deepEqual(await p.cli(quiet, ["order-status", result.id]), await p.client.registrar.getOrder(result.id));
  const cases = [
    [c => c.registrar.check(["example.com"]), ["check", "example.com"]],
    [c => c.registrar.quote({ domain: "example.com", kind: "renew", years: 1 }), ["quote", "--data", JSON.stringify({ domain: "example.com", kind: "renew", years: 1 })]],
    [c => c.registrar.orders({ limit: 20, after: "cursor" }), ["orders", "--limit", "20", "--after", "cursor"]],
    [c => c.registrar.domains("next"), ["domains", "--cursor", "next"]],
    [c => c.registrar.setNameservers("example.com", ["ns1.example.com", "ns2.example.com"]), ["set-nameservers", "example.com", "ns1.example.com", "ns2.example.com"]],
    [c => c.registrar.disconnect(), ["disconnect"]],
  ];
  for (const [sdk, cli] of cases) assert.deepEqual(await viaSdk(sdk), await viaCli(runRegistrarCommand, cli));
});

test("deadline and malformed receipts stay unknown, while explicit refusal is terminal", async () => {
  const { registrar, fake } = await ready({ submitTimeoutMs: 5 });
  fake.state.submit = () => new Promise(() => {});
  const timed = await registrar.order(orderInput(), "owner"); assert.equal(timed.order.state, "unknown");
  fake.state.submit = async () => ({});
  const malformed = await registrar.order(orderInput({ domain: "receipt.com", idempotencyKey: "receipt-key-0001" }), "owner"); assert.equal(malformed.order.state, "unknown");
  fake.state.submit = async () => { throw Object.assign(new Error("private contact and credentials"), { definite: true }); };
  const refused = await registrar.order(orderInput({ domain: "refused.com", idempotencyKey: "refused-key-0001" }), "owner"); assert.equal(refused.order.state, "failed");
  await registrar.order(orderInput({ domain: "refused.com", idempotencyKey: "refused-key-0001" }), "owner"); assert.equal(fake.state.calls.length, 3);
  await registrar.close();
});

test("uncertain renewal remains blocked after 24 hours and cannot spend again under a new key", async () => {
  let time = Date.parse("2026-11-16T00:00:00.000Z");
  const { registrar, fake } = await ready({ now: () => new Date(time) });
  fake.state.owned.set("example.com", "2027-11-16T00:00:00.000Z"); fake.state.submit = async () => { throw new Error("lost response"); };
  const result = await registrar.order(orderInput({ kind: "renew" }), "owner");
  time += 86_400_001; await registrar.reconcile();
  const current = await registrar.getOrder(result.order.id); assert.equal(current.state, "unknown"); assert.match(current.detail, /24 hours/);
  await assert.rejects(registrar.order(orderInput({ kind: "renew", idempotencyKey: "new-renew-key" }), "owner"), e => e.code === "registrar_busy"); assert.equal(fake.state.calls.length, 1);
});

test("growing order history is paged and active order admission stops at 200", async () => {
  const { registrar, store, fake } = await ready();
  const first = await registrar.order(orderInput(), "owner"); const row = (await store.get("registrar.orders", first.order.id)).value;
  for (let i = 0; i < 52; i++) {
    const id = `${String(1000 + i).padStart(16, "0")}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await store.set("registrar.orders", id, { ...row, id });
  }
  const page = await registrar.orders(); assert.equal(page.orders.length, 50); assert.ok(page.next);
  assert.equal((await registrar.orders({ after: page.next })).orders.length, 3);
  for (let i = 0; i < 200; i++) {
    const id = `${String(2000 + i).padStart(16, "0")}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await store.set("registrar.active-orders", id, { ...row, id, state: "unknown" });
  }
  await assert.rejects(registrar.order(orderInput({ domain: "limit.com", idempotencyKey: "over-limit-key" }), "owner"), e => e.code === "registrar_busy"); assert.equal(fake.state.calls.length, 1);
});

test("malformed provider quotes are provider failures and cannot create an intent", async () => {
  const { registrar, fake, store } = await ready();
  fake.state.price.amount = "not money";
  await assert.rejects(registrar.order(orderInput(), "owner"), e => e.code === "registrar_failed");
  assert.equal(fake.state.calls.length, 0);
  assert.equal((await store.list("registrar.order-keys")).length, 0);
});

test("Platform shutdown records an interrupted purchase and a reopened SQLite store reconciles it once", async t => {
  const { platform } = await import("./_runtime.mjs");
  const { createLocalSqliteSystemStore } = await import("../dist/adapters/_sqlite-system-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "zelavis-registrar-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "system.sqlite"), fake = fakeRegistrar();
  const first = await platform(t, { systemStore: createLocalSqliteSystemStore({ filename }), edgeRegistrars: [fake.definition] });
  await first.client.registrar.connect({ provider: "fake", sandbox: true, credentials: { token: "test-secret" } });
  await first.client.registrar.setContact({ contact });
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  fake.state.submit = (_input, context) => new Promise((_resolve, reject) => {
    enter(); context.signal.addEventListener("abort", () => reject(new Error("Platform shut down")), { once: true });
  });
  const buying = first.client.registrar.order(orderInput()); await entered;
  await first.runtime.close(); const interrupted = await buying;
  assert.equal(interrupted.state, "unknown");
  fake.state.owned.set("example.com", "2027-11-16T00:00:00.000Z");
  const second = await platform(t, { systemStore: createLocalSqliteSystemStore({ filename }), edgeRegistrars: [fake.definition] });
  let order;
  const deadline = Date.now() + 5000;
  do { order = await second.client.registrar.getOrder(interrupted.id); if (order.state === "completed") break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.equal(order.state, "completed");
  assert.equal((await second.client.registrar.order(orderInput())).id, interrupted.id);
  assert.equal(fake.state.calls.length, 1);
  await second.runtime.close();
});
