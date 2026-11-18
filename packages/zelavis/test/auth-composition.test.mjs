/**
 * Zelavis Auth composed into runtimes (part 13): a Platform and an App each run their own Auth on their own database,
 * sign people up and in through `/auth`, and refuse each other's tokens. The Node adapter keeps the Platform's in the
 * Platform identity database and carries the recorded alpha.45 Identity records on first start.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystemStore, Zelavis, zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { openTemporaryDatabase } from "./_database.mjs";

const TOKEN = "zelavis-bootstrap-token-of-at-least-32-chars";
const PASSWORD = "paper lantern holds a cloud";
const API = "http://localhost/zelavis/api/v1";

const client = (runtime) => {
  const call = (path, { method = "GET", body, token } = {}) => runtime.fetch(new Request(`${API}/auth/${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const json = async (response, status) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  return { call, json };
};

async function platformRuntime(t, options = {}) {
  const runtime = await zelavis({ systemStore: createMemorySystemStore(), bootstrap: { token: TOKEN }, subsystems: { auth: { registration: true } }, ...options });
  t.after(() => runtime.close());
  return runtime;
}

async function appRuntime(t, projectId) {
  const database = await openTemporaryDatabase(t);
  const runtime = await zelavis({
    role: "project",
    systemStore: createMemorySystemStore(),
    subsystems: { database: database.api, auth: { registration: true } },
    serviceContext: { platform: { metadata: { projectId } } },
  });
  t.after(() => runtime.close());
  return runtime;
}

test("a Platform bootstraps its owner, signs in, refreshes and signs out through its own Auth", async (t) => {
  const runtime = await platformRuntime(t);
  const { call, json } = client(runtime);
  assert.equal((await json(await call("bootstrap"), 200)).required, true);
  const claimed = await json(await call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD } }), 201);
  const session = await json(await call("session", { token: claimed.tokens.accessToken }), 200);
  assert.deepEqual(session.account.roles, ["owner"]);
  const signedIn = await json(await call("username-password/sign-in", { method: "POST", body: { username: "owner", password: PASSWORD } }), 200);
  const refreshed = await json(await call("session/refresh", { method: "POST", body: { refreshToken: signedIn.tokens.refreshToken } }), 200);
  assert.equal(refreshed.kind, "rotated");
  assert.ok(refreshed.tokens.accessToken);
  assert.equal((await call("session", { method: "DELETE", token: refreshed.tokens.accessToken })).status < 300, true);
  assert.equal((await json(await call("session", { token: refreshed.tokens.accessToken }), 401)).code, "not_signed_in");
  // Runtime services see the same Auth as `core.auth`.
  const principal = await runtime.auth.principalFor(new Request(`${API}/auth/session`, { headers: { authorization: `Bearer ${claimed.tokens.accessToken}` } }));
  assert.equal(principal.id, claimed.userId ?? claimed.tokens.userId);
  assert.equal((await runtime.auth.accounts.get(principal.id)).roles[0], "owner");
});

test("Platform sign-up makes a customer, App sign-up makes a user, and neither runtime accepts the other's tokens", async (t) => {
  const platform = await platformRuntime(t);
  const app = await appRuntime(t, "first-app");
  const sibling = await appRuntime(t, "second-app");
  const p = client(platform), a = client(app), s = client(sibling);
  await p.json(await p.call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD } }), 201);
  const customer = await p.json(await p.call("username-password/sign-up", { method: "POST", body: { username: "customer", password: PASSWORD } }), 200);
  assert.deepEqual((await p.json(await p.call("session", { token: customer.tokens.accessToken }), 200)).account.roles, ["customer"]);
  const user = await a.json(await a.call("username-password/sign-up", { method: "POST", body: { username: "customer", password: PASSWORD } }), 200);
  const appSession = await a.json(await a.call("session", { token: user.tokens.accessToken }), 200);
  assert.deepEqual(appSession.account.roles, ["user"]);
  assert.deepEqual(appSession.account.grants, []);
  assert.deepEqual(appSession.account.permissions, []);

  // Same username, separate runtimes: separate accounts, separate keys.
  assert.equal((await p.call("session", { token: user.tokens.accessToken })).status, 401, "the Platform refuses an App token");
  assert.equal((await a.call("session", { token: customer.tokens.accessToken })).status, 401, "an App refuses a Platform token");
  assert.equal((await s.call("session", { token: user.tokens.accessToken })).status, 401, "an App refuses a sibling App's token");
  assert.equal((await a.json(await a.call("session/refresh", { method: "POST", body: { refreshToken: customer.tokens.refreshToken } }), 200)).kind, "noSession");
  const platformKeys = await p.json(await p.call("jwks"), 200);
  const appKeys = await a.json(await a.call("jwks"), 200);
  assert.ok(platformKeys.keys.every((key) => !appKeys.keys.some((other) => other.kid === key.kid)));
});

test("the Node adapter keeps Platform Auth in its identity database and carries alpha.45 Identity records on first start", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "zv-auth-composition-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  // The published release kept Platform Identity in the System Store; write its recorded records there.
  const seeded = createLocalSqliteSystemStore({ filename: join(dataDirectory, "system", "zelavis.sqlite") });
  const rows = (await readFile(new URL("./fixtures/identity-import/platform.jsonl", import.meta.url), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const row of rows) await seeded.set(row.namespace, row.key, row.value);
  await seeded.close?.();

  const open = async () => {
    const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory, projects: false }) });
    const runtime = await zv.runtime();
    return { zv, runtime, ...client(runtime) };
  };
  const first = await open();
  const signedIn = await first.json(await first.call("email-password/sign-in", { method: "POST", body: { email: "root@example.test", password: PASSWORD } }), 200);
  assert.equal(signedIn.userId, "alpha-45-account");
  assert.equal((await first.json(await first.call("bootstrap"), 200)).required, false);
  await first.zv.close();

  // Started again, the import is not repeated and the account is still there.
  const second = await open();
  t.after(() => second.zv.close());
  assert.equal((await second.json(await second.call("email-password/sign-in", { method: "POST", body: { email: "root@example.test", password: PASSWORD } }), 200)).userId, "alpha-45-account");
});
