/**
 * Zelavis Auth, the first owner (part 11): `GET|POST /auth/bootstrap` over `test/_auth.mjs`. Ported from
 * `test/cli-bootstrap.test.mjs` (the Platform's side of it: status, token, credential) and Identity's bootstrap rules.
 *
 * Not ported: the CLI's own prompts and argument handling (they test the CLI, which part 13 points at these routes),
 * and Identity's pending-account cleanup and claim lease, which a single-transaction claim does not need.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { bootstrapTables } from "../dist/auth/bootstrap/tables.js";
import { passwordTables } from "../dist/auth/password/tables.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { usernameTables } from "../dist/auth/username/tables.js";
import { composeAuth, expectStatus, recordingOutbox } from "./_auth.mjs";

const TOKEN = "zelavis-bootstrap-token-of-at-least-32-chars";
const PASSWORD = "correct horse battery staple";

const fresh = (t, options = {}) => composeAuth(t, { bootstrapped: false, registration: true, bootstrapToken: TOKEN, ...options });
const claim = (a, body = {}) => a.call("bootstrap", { method: "POST", body: { bootstrapToken: TOKEN, username: "owner", password: PASSWORD, ...body } });

test("a fresh Platform reports that its first owner is required and that the token is configured", async (t) => {
  const a = await fresh(t);
  assert.deepEqual(await expectStatus(await a.call("bootstrap"), 200), { required: true, available: true, tokenRequired: true, methods: ["usernamePassword"] });
  const without = await composeAuth(t, { bootstrapped: false, registration: true });
  assert.equal((await expectStatus(await without.call("bootstrap"), 200)).available, false);
  assert.equal((await expectStatus(await claim(without), 503)).code, "bootstrap_disabled");
});

test("the token is checked before anything else, and a wrong one writes nothing", async (t) => {
  const a = await fresh(t);
  for (const bootstrapToken of [undefined, "", `${TOKEN}x`, 42]) {
    assert.equal((await expectStatus(await claim(a, { bootstrapToken }), 403)).code, "invalid_bootstrap_token");
  }
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
  assert.equal((await expectStatus(await claim(a, { password: "short" }), 400)).code, "password_too_short");
  assert.equal((await expectStatus(await claim(a, { username: " owner" }), 400)).code, "username_has_surrounding_whitespace");
  assert.equal((await expectStatus(await claim(a, { extra: true }), 400)).code, "invalid_request");
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
});

test("the owner is created with its username, password and first session; later claims answer 409", async (t) => {
  const a = await fresh(t);
  const created = await expectStatus(await claim(a, { displayName: "Owner" }), 201);
  assert.equal(created.status, "complete");
  assert.deepEqual(created.account.roles, ["owner"]);
  assert.deepEqual(created.account.permissions, ["*"]);
  const session = await expectStatus(await a.call("session", { headers: a.bearer(created.tokens) }), 200);
  assert.equal(session.account.id, created.userId);
  assert.equal(session.account.displayName, "Owner");
  assert.deepEqual(await expectStatus(await a.call("bootstrap"), 200), { required: false, available: true, tokenRequired: true, methods: ["usernamePassword"] });
  assert.equal((await expectStatus(await claim(a, { username: "second" }), 409)).code, "bootstrap_complete");
  // The owner signs in later with username and password.
  const signIn = await expectStatus(await a.call("username-password/sign-in", { method: "POST", body: { username: "owner", password: PASSWORD } }), 200);
  assert.equal(signIn.userId, created.userId);
  const events = (await a.rows(securityTables.events)).map((event) => event.kind);
  assert.ok(events.includes("bootstrap.owner_created"));
});

test("32 concurrent claims create exactly one owner", async (t) => {
  const a = await fresh(t);
  const responses = await Promise.all(Array.from({ length: 32 }, (_, i) => claim(a, { username: `owner${i}` })));
  const statuses = responses.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 201).length, 1, JSON.stringify(statuses));
  assert.equal(statuses.filter((status) => status === 409).length, 31, JSON.stringify(statuses));
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);
  assert.equal((await a.rows(bootstrapTables.claims)).length, 1);
  assert.equal((await a.rows(usernameTables.usernames)).length, 1);
  assert.equal((await a.rows(passwordTables.passwords)).length, 1);
});

test("nobody signs up on a Platform before its owner exists, even with registration open", async (t) => {
  const a = await fresh(t);
  const body = { username: "early", password: PASSWORD };
  assert.equal((await expectStatus(await a.call("username-password/sign-up", { method: "POST", body }), 403)).code, "registration_closed");
  assert.equal((await expectStatus(await a.call("registration"), 200)).enabled, false);
  await expectStatus(await claim(a), 201);
  assert.equal((await expectStatus(await a.call("registration"), 200)).enabled, true);
  await expectStatus(await a.call("username-password/sign-up", { method: "POST", body }), 200);
});

test("an email given at bootstrap starts the add-email challenge once delivery is configured", async (t) => {
  const outbox = recordingOutbox();
  const a = await fresh(t, { emailOutbox: outbox });
  const created = await expectStatus(await claim(a, { email: "owner@example.test" }), 201);
  assert.equal(created.emailVerification.status, "sent");
  assert.equal(typeof created.emailVerification.browserSecret, "string");
  const without = await fresh(t);
  assert.deepEqual((await expectStatus(await claim(without, { email: "owner@example.test" }), 201)).emailVerification, { status: "unavailable" });
});

test("a bootstrap token outside 32 to 1024 characters is refused at start", async (t) => {
  await assert.rejects(composeAuth(t, { bootstrapToken: "too-short" }), /between 32 and 1024 characters/);
});
