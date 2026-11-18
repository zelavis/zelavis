import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Deferred, Effect } from "effect";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { createAuth } from "../dist/auth/create-auth.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { bootstrapTables } from "../dist/auth/bootstrap/tables.js";
import { oauthConnectionsTables, oauthTables } from "../dist/auth/oauth/tables.js";
import { passwordTables } from "../dist/auth/password/tables.js";
import { registrationTables } from "../dist/auth/registration/tables.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { serviceAccountTables } from "../dist/auth/serviceAccounts/tables.js";
import { importTables } from "../dist/auth/import/state.js";
import {
  IdentityImportFailure, IMPORT_PAGE_SIZE, projectDatabaseIdentitySource, systemStoreIdentitySource,
} from "../dist/auth/import/sources.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { emailLinkOf, fakeOAuthProvider, fragmentOf, openAuthTestTenant, recordingOutbox, TEST_MASTER_SECRET, waitFor } from "./_auth.mjs";

const PROJECT_ID = "example-app";
const ORIGIN = "https://auth.example.test";
const ROOT = "root@example.test";
const PERSON = "person@example.test";
// Apache bcrypt hash of the fixture password "short".
const BCRYPT_SHORT = "$2y$05$guQQF.7Y1briSwnHQRZ4Ou5JPGuMKhbQRR9PjATYyaTkdpfnXdrzq";
const SHORT_PASSWORD = "short";
const PASSWORD = "paper lantern holds a cloud";
const GRANT = { permission: "project.data.read", scope: { type: "project", projectId: PROJECT_ID } };
const run = Effect.runPromise;
const legacyNamespace = "zelavis.platform.auth";
const legacyProviders = "zelavis.service:zelavis/identity:oauth";

async function writeLegacyDocument(database, tenant, collection, id, data) {
  const { documents } = database.forTenant(tenant);
  if (!(await run(documents.collectionExists(collection)))) await run(documents.createCollection({ name: collection }));
  await run(documents.insert({ collection, id, data }));
}

function publishedRecords(role, store, database) {
  const now = new Date().toISOString();
  const put = (kind, row) => role === "platform"
    ? store.set(legacyNamespace, `${kind}:${row.id}`, row)
    : writeLegacyDocument(database, "service:zelavis-auth", `auth_${kind}s`, row.id, { entity: JSON.stringify(row) });
  return {
    account: (account) => put("account", { verified: false, createdAt: now, updatedAt: now, ...account }),
    credential: (credential) => put("credential", { createdAt: now, updatedAt: now, ...credential }),
    session: (session) => put("session", { status: "active", epoch: 0, createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...session }),
    registration: () => {
      const record = { id: "registration", schemaVersion: 1, enabled: true, revision: 1 };
      return role === "platform" ? store.set(legacyNamespace, "registration", record)
        : writeLegacyDocument(database, "service:zelavis-auth", "auth_registration", "registration", record);
    },
    bootstrap: () => store.set("zelavis.platform.auth.bootstrap", "first-owner", {
      claimId: "fixture-owner", status: "complete", createdAt: now, updatedAt: now,
    }),
  };
}

function serviceTokenPrefix(role) {
  return role === "platform" ? "zvs_" : `zvs_app_${createHash("sha256").update(PROJECT_ID).digest("hex").slice(0, 24)}_`;
}

function fromStore(role, store, database) {
  return role === "platform" ? systemStoreIdentitySource(store) : projectDatabaseIdentitySource(database);
}

async function writeConnection(role, store, database, provider, name, issuer = provider.origin) {
  const connection = {
    provider: name, issuer,
    discovered: {
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksUrl: `${issuer}/jwks`,
      algorithms: ["RS256"],
    },
    clientId: provider.state.clientId,
    clientSecret: provider.state.clientSecret,
    redirectUri: `${ORIGIN}/auth/oauth/${name}/callback`,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  if (role === "platform") {
    await store.set(legacyProviders, `connection:${name}`, connection);
  } else {
    await writeLegacyDocument(database, "service:zelavis-auth-settings", "auth_provider_settings", `connection:${name}`, { value: connection });
  }
}

async function compose(options) {
  const auth = await run(createAuth(options));
  const runtime = await createServiceRuntime({
    endpointGroups: [{
      id: "auth", basePath: "/auth", context: auth, api: { v1: auth.routes },
      authenticators: [auth.requestAuthenticator], origin: { type: "subsystem", subsystem: "auth-test" },
    }],
  });
  const request = (path, { method = "GET", body, token, url } = {}) => runtime.fetch(new Request(url ?? `${ORIGIN}/auth/${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const post = (path, body, token) => request(path, { method: "POST", body, token });
  const rows = (table) => run(auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const principal = (token) => run(auth.authenticate(new Request(ORIGIN, { headers: { authorization: `Bearer ${token}` } })));
  return { auth, request, post, rows, principal };
}

async function json(response, status) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

async function signInOAuth(app, provider, name) {
  const { url, state } = await json(await app.post(`oauth/${name}/start`, { redirectTo: `${ORIGIN}/return` }), 200);
  const { callback } = provider.authorize(url);
  const response = await app.request("", { url: callback });
  assert.equal(response.status, 302, await response.text());
  const ticket = fragmentOf(response).fragment.get("ticket");
  assert.ok(ticket);
  return json(await app.post(`oauth/${name}/redeem`, { ticket, state }), 200);
}

for (const role of ["platform", "project"]) {
  test(`${role}: preserve published credentials, account access, verified proof and live service tokens`, async (t) => {
    const { database, tenant } = await openAuthTestTenant(t);
    const store = createMemorySystemStore();
    const records = publishedRecords(role, store, database);
    const provider = await fakeOAuthProvider(t);
    const reusedProvider = await fakeOAuthProvider(t);
    await records.registration();
    const owner = { id: "owner-1", email: ROOT, ...(role === "platform" ? { roles: ["owner"], permissions: ["*"] } : { roles: ["user"] }) };
    await records.account(owner);
    const hash = JSON.parse((await readFile(new URL("./fixtures/identity-import/platform.jsonl", import.meta.url), "utf8"))
      .split("\n").find(line => line.includes("credential:alpha-45-password"))).value.secretHash;
    await records.credential({ id: "owner-password", accountId: owner.id, provider: "password", identifier: ROOT, secretHash: hash });
    const oldHumanToken = randomBytes(32).toString("base64url");
    await records.session({ id: "owner-session", accountId: owner.id, tokenHash: createHash("sha256").update(oldHumanToken).digest("base64url"),
      ...(role === "platform" ? { metadata: { bootstrap: true } } : {}),
    });
    if (role === "platform") await records.bootstrap();
    const person = { id: "person-1", email: PERSON, verified: true, permissions: ["data.read"], grants: [GRANT] };
    await records.account(person);
    await records.credential({ id: "password-1", accountId: person.id, provider: "password", identifier: "other@example.test", secretHash: BCRYPT_SHORT });
    await records.credential({ id: "unproven-1", accountId: person.id, provider: "reused", identifier: "unproven-subject", metadata: { provider: "reused" } });
    await records.credential({ id: "bound-to-previous-issuer", accountId: person.id, provider: "reused", identifier: reusedProvider.state.subject, metadata: { provider: "reused", issuer: "https://old-issuer.example.test" } });
    const username = "a".repeat(110);
    const named = { id: "username-1", username };
    await records.account(named);
    await records.credential({ id: "username-password", accountId: named.id, identifier: username, provider: "password", secretHash: BCRYPT_SHORT });
    const oauth = { id: "oauth-1", username: "oauth-user", roles: ["custom"] };
    await records.account(oauth);
    await records.credential({ id: "proven-1", accountId: oauth.id, provider: "existing", identifier: provider.state.subject, metadata: { provider: "existing", issuer: provider.origin } });
    await writeConnection(role, store, database, provider, "existing");
    await writeConnection(role, store, database, reusedProvider, "reused");

    const service = { id: "service-1", metadata: { principalType: "service", tenantId: "test-tenant" }, grants: [GRANT], sessionEpoch: 1 };
    await records.account(service);
    const issue = async (id, epoch, status) => {
      const token = serviceTokenPrefix(role) + randomBytes(32).toString("base64url");
      await records.session({ id, status, epoch, accountId: service.id, tokenHash: createHash("sha256").update(token).digest("base64url"),
        metadata: { authentication: "service-token", serviceAccount: true },
      });
      return token;
    };
    const stale = await issue("stale", 0, "active");
    const live = await issue("live", 1, "active");
    const revoked = await issue("revoked", 1, "revoked");
    const source = fromStore(role, store, database);
    const before = await run(source.pages("accounts"));
    const sessionsBefore = await run(source.pages("sessions"));
    if (role === "platform") store.set(legacyNamespace, "account:corrupt", { id: "corrupt" });
    const outbox = recordingOutbox();
    const options = {
      role, projectId: role === "project" ? PROJECT_ID : undefined, tenant, masterSecret: TEST_MASTER_SECRET,
      importFrom: source, emailOutbox: outbox,
      oauth: { fetch: (url, init) => (String(url).startsWith(provider.origin) ? provider : reusedProvider).fetch(url, init) },
    };
    const app = await compose(options);
    const running = await run(app.auth.start());
    try {
      await run(running.waitForImport);
      const [completed] = await app.rows(importTables.state);
      assert.equal(completed.status, "done");
      assert.equal(completed.imported, 5);
      assert.equal(completed.skipped, role === "platform" ? 1 : 0);
      assert.equal(completed.unprovenLinks, 1);
      assert.deepEqual((await app.rows(securityTables.events))
        .filter((event) => event.kind === "identity.oauth_relink_required").map((event) => event.accountId), [person.id]);
      assert.equal((await app.rows(registrationTables.policy))[0].revision, 1);
      const [claim] = await app.rows(bootstrapTables.claims);
      assert.equal(claim?.accountId, role === "platform" ? owner.id : undefined);
      assert.equal(await app.principal(oldHumanToken), undefined);
      assert.equal(await app.principal(stale), undefined);
      assert.equal(await app.principal(revoked), undefined);
      assert.equal((await app.rows(serviceAccountTables.tokens)).length, 1);
      const machine = await app.principal(live);
      assert.equal(machine.id, service.id);
      assert.equal(machine.metadata.tenantId, "test-tenant");
      assert.deepEqual(machine.grants, [GRANT]);
      assert.ok((await app.rows(oauthConnectionsTables.connections)).every((row) => row.sealedClientSecret?.algorithm === "AES-256-GCM"));
      assert.equal((await signInOAuth(app, provider, "existing")).userId, oauth.id);
      const importedLinks = await app.rows(oauthTables.accounts);
      assert.ok(importedLinks.some((link) => link.userId === person.id && link.issuer === "https://old-issuer.example.test"));
      assert.ok(!importedLinks.some((link) => link.issuer === reusedProvider.origin));
      assert.notEqual((await signInOAuth(app, reusedProvider, "reused")).userId, person.id);

      const emailLogin = (email, password) => app.post("email-password/sign-in", { email, password });
      const root = await json(await emailLogin(ROOT, PASSWORD), 200);
      assert.equal(root.userId, owner.id);
      const personLogin = await json(await emailLogin("other@example.test", SHORT_PASSWORD), 200);
      assert.equal(personLogin.userId, person.id);
      const rehashed = (await app.rows(passwordTables.passwords)).find((row) => row.userId === person.id);
      assert.match(rehashed.passwordHashPHC, /^\$pbkdf2-sha256\$/u);
      assert.equal(rehashed.imported, true);
      assert.deepEqual((await app.principal(personLogin.tokens.accessToken)).grants.filter((grant) => grant.permission === GRANT.permission), [GRANT]);
      assert.equal((await json(await app.post("username-password/sign-in", { username, password: SHORT_PASSWORD }), 200)).userId, named.id);

      const recoveryBefore = await json(await app.post("email-password/recovery/start", { email: ROOT }), 404);
      assert.equal(recoveryBefore.code, "email_not_found");
      assert.equal((await json(await app.post("email-password/recovery/start", { email: "other@example.test" }), 404)).code, "email_not_found",
        "proof for a different address cannot authorize recovery at the reserved address");
      assert.equal((await json(await app.post("email-password/sign-up", { email: ROOT, password: PASSWORD }), 409)).code, "email_taken");
      assert.equal((await json(await app.post("emails/add/start", { email: ROOT }, personLogin.tokens.accessToken), 409)).code, "email_taken");

      const verification = await json(await app.post("emails/add/start", { email: ROOT }, root.tokens.accessToken), 200);
      await waitFor(() => outbox.delivered.some((message) => message.to === ROOT));
      const { code } = emailLinkOf(outbox.delivered.find((message) => message.to === ROOT));
      await json(await app.post("emails/add/complete", { emailCode: code, browserSecret: verification.browserSecret }, root.tokens.accessToken), 200);
      const recovery = await json(await app.post("email-password/recovery/start", { email: ROOT }), 200);
      assert.ok(recovery.browserSecret);

      const after = await run(source.pages("accounts"));
      assert.deepEqual(after.records.filter((row) => row.id !== "corrupt"), before.records);
      assert.deepEqual(await run(source.pages("sessions")), sessionsBefore, "the original engine keeps its session records");
      const countingSource = {
        fingerprint: source.fingerprint,
        pages: () => Effect.die(new Error("Completed import read source records again")),
        settings: () => Effect.die(new Error("Completed import read source settings again")),
      };
      const reopened = await compose({ ...options, importFrom: countingSource });
      const startedAgain = await run(reopened.auth.start());
      await run(startedAgain.stop());
      assert.equal((await reopened.rows(securityTables.events)).filter((event) => event.kind === "identity.imported").length, 1);
    } finally {
      await run(running.stop());
    }
  });
}

test("an App serves 503 and resumes from the last committed page after an interrupted import", async (t) => {
  const { tenant, database } = await openAuthTestTenant(t);
  const records = publishedRecords("project", undefined, database);
  for (let index = 0; index <= IMPORT_PAGE_SIZE; index += 1) {
    const accountId = `user-${index}`;
    const email = `${accountId}@example.test`;
    await records.account({ id: accountId, email, verified: false });
    await records.credential({
      id: `credential-${index}`, accountId, identifier: email, provider: "password", secretHash: BCRYPT_SHORT,
    });
  }
  const source = projectDatabaseIdentitySource(database);
  const readingSecondPage = Deferred.makeUnsafe();
  const blockedSource = {
    ...source,
    pages: (kind, after) => kind === "accounts" && after !== undefined
      ? Effect.andThen(Deferred.succeed(readingSecondPage, after), Effect.never)
      : source.pages(kind, after),
  };
  const options = { tenant, role: "project", projectId: PROJECT_ID, masterSecret: TEST_MASTER_SECRET };
  const first = await compose({ ...options, importFrom: blockedSource });
  const started = await run(first.auth.start());
  let after;
  try {
    after = await run(Deferred.await(readingSecondPage).pipe(Effect.timeout("15 seconds")));
    assert.equal((await first.rows(accountsTables.accounts)).length, IMPORT_PAGE_SIZE);
    for (const [path, body] of [["username-password/sign-in", { username: "user-0", password: PASSWORD }], ["session/refresh", {}]]) {
      const response = await first.post(path, body);
      assert.equal(response.headers.get("retry-after"), "1");
      assert.equal((await json(response, 503)).code, "auth_importing");
    }
  } finally {
    await run(started.stop());
  }
  const noSource = await run(Effect.flip(createAuth(options)));
  assert.equal(noSource._tag, "IdentityImportFailure");
  assert.match(noSource.message, /original source/u);

  const inputs = [];
  const second = await compose({ ...options, importFrom: {
    ...source,
    pages: (kind, cursor) => Effect.sync(() => { inputs.push([kind, cursor]); }).pipe(Effect.andThen(source.pages(kind, cursor))),
  } });
  const resumed = await run(second.auth.start());
  try {
    await run(resumed.waitForImport);
    assert.deepEqual(inputs[0], ["accounts", after]);
    assert.equal((await second.rows(accountsTables.accounts)).length, IMPORT_PAGE_SIZE + 1);
    assert.equal((await second.rows(passwordTables.passwords)).length, IMPORT_PAGE_SIZE + 1);
    assert.equal((await second.rows(importTables.state))[0].imported, IMPORT_PAGE_SIZE + 1);
  } finally {
    await run(resumed.stop());
  }
});

test("an OAuth-only account with no qualified issuer refuses activation", async (t) => {
  const { tenant, database } = await openAuthTestTenant(t);
  const provider = await fakeOAuthProvider(t);
  const records = publishedRecords("project", undefined, database);
  await records.account({ id: "oidc-only", verified: false });
  await records.credential({
    id: "retired-link", accountId: "oidc-only", provider: "existing", identifier: "subject-1",
    metadata: { provider: "existing", issuer: "https://old-issuer.example.test" },
  });
  await records.credential({
    id: "damaged-password", accountId: "oidc-only", provider: "password", identifier: "damaged",
    secretHash: "scrypt$invalid",
  });
  await writeConnection("project", undefined, database, provider, "existing");
  const app = await compose({
    tenant, role: "project", projectId: PROJECT_ID, masterSecret: TEST_MASTER_SECRET,
    importFrom: projectDatabaseIdentitySource(database),
  });
  const started = await run(app.auth.start());
  try {
    const failure = await run(Effect.flip(started.waitForImport));
    assert.ok(failure instanceof IdentityImportFailure);
    assert.match(failure.message, /oidc-only has no qualified sign-in path/u);
    assert.equal((await app.rows(importTables.state))[0].status, "running");
    assert.equal((await json(await app.post("oauth/existing/start", { redirectTo: ORIGIN }), 503)).code, "auth_importing");
    assert.ok((await run(projectDatabaseIdentitySource(database).pages("credentials"))).records.some(({ id }) => id === "retired-link"));
  } finally {
    await run(started.stop());
  }
});

test("an imported identifier cannot override another account's verified email", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  const store = createMemorySystemStore();
  const records = publishedRecords("platform", store);
  await records.account({ id: "verified-account", email: ROOT, verified: true });
  await records.account({ id: "conflicting-account", username: "conflicting-account", verified: false });
  await records.credential({
    id: "conflicting-password", accountId: "conflicting-account", provider: "password", identifier: ROOT,
    secretHash: BCRYPT_SHORT,
  });
  const app = await compose({
    tenant, role: "platform", masterSecret: TEST_MASTER_SECRET, importFrom: systemStoreIdentitySource(store),
  });
  const failure = await run(Effect.flip(app.auth.start()));
  assert.match(failure.message, /email login identifiers conflict/u);
  assert.equal((await app.rows(passwordTables.passwords)).length, 0);
  assert.equal((await json(await app.post("email-password/sign-in", { email: ROOT, password: SHORT_PASSWORD }), 503)).code, "auth_importing");
});

/** Writes the recorded alpha.45 Identity records of `role` where that release kept them. */
async function loadFixture(role, store, tenant) {
  const fixture = new URL(`./fixtures/identity-import/${role}.jsonl`, import.meta.url);
  const rows = (await readFile(fixture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const collections = new Set();
  for (const row of rows) {
    if (role === "platform") {
      store.set(row.namespace, row.key, row.value);
    } else {
      if (!collections.has(row.collection)) {
        await run(tenant.documents.createCollection({ name: row.collection }));
        collections.add(row.collection);
      }
      await run(tenant.documents.insert(row));
    }
  }
}

for (const role of ["platform", "project"]) {
  test(`${role}: imports the recorded Alpha Identity fixture`, async (t) => {
    const { tenant, database } = await openAuthTestTenant(t);
    const store = createMemorySystemStore();
    await loadFixture(role, store, tenant);
    const app = await compose({ tenant, role, projectId: PROJECT_ID, masterSecret: TEST_MASTER_SECRET, importFrom: fromStore(role, store, database) });
    const started = await run(app.auth.start());
    try {
      await run(started.waitForImport);
      const signedIn = await json(await app.post("email-password/sign-in", { email: ROOT, password: PASSWORD }), 200);
      assert.equal(signedIn.userId, "alpha-45-account");
      assert.equal((await app.principal(`${serviceTokenPrefix(role)}${"A".repeat(43)}`)).id, "alpha-45-service");
    } finally {
      await run(started.stop());
    }
  });
}

for (const role of ["platform", "project"]) {
  test(`${role}: a rollback that lets the prior engine write again rebuilds Auth from its records`, async (t) => {
    const { tenant, database } = await openAuthTestTenant(t);
    const store = createMemorySystemStore();
    await loadFixture(role, store, tenant);
    const options = { tenant, role, projectId: PROJECT_ID, masterSecret: TEST_MASTER_SECRET, importFrom: fromStore(role, store, database) };
    const NEW_PASSWORD = "a newer lantern holds the storm";
    const signIn = async (app, password) => (await app.post("email-password/sign-in", { email: ROOT, password })).status;
    const open = async () => {
      const app = await compose(options);
      const started = await run(app.auth.start());
      await run(started.waitForImport);
      t.after(() => run(started.stop()));
      return app;
    };

    // Activation: the candidate imports, and an account changes its password there.
    const first = await open();
    const session = await json(await first.post("email-password/sign-in", { email: ROOT, password: PASSWORD }), 200);
    await json(await first.post("email-password/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, session.tokens.accessToken), 200);

    // Started again with the source untouched (no rollback, or one during which the prior engine wrote nothing):
    // Auth keeps what was written to it after activation.
    const kept = await open();
    assert.equal(await signIn(kept, NEW_PASSWORD), 200);
    assert.equal((await kept.rows(securityTables.events)).filter((event) => event.kind === "identity.import_rebuilt").length, 0);

    // A rollback hands the prior engine write authority again, and it writes (here it rewrites the account record).
    if (role === "platform") {
      const record = await store.get(legacyNamespace, "account:alpha-45-account");
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.set(legacyNamespace, "account:alpha-45-account", record.value);
    } else {
      const current = await run(tenant.documents.findById({ collection: "auth_accounts", id: "alpha-45-account" }));
      await run(tenant.documents.update({ collection: "auth_accounts", id: current.id, data: current.data, mode: "replace", expectedVersion: current.version }));
    }

    if (role === "project") {
      // Fail after account and checkpoint handling would formerly have diverged.
      const faultyTenant = {
        ...tenant,
        documents: {
          ...tenant.documents,
          dropCollection: input => input.name === registrationTables.policy.collection
            ? Effect.die(new Error("interrupted table reset"))
            : tenant.documents.dropCollection(input),
        },
      };
      await assert.rejects(compose({ ...options, tenant: faultyTenant }), /interrupted table reset/u);
      const [checkpoint] = await kept.rows(importTables.state);
      assert.equal(checkpoint.status, "resetting");
      assert.equal((await kept.rows(accountsTables.accounts)).length, 0);
    }

    // The next candidate rebuilds from the prior engine's records: its password is the one that works, the change
    // made in Auth before the rollback is gone, and the security log records the rebuild.
    const rebuilt = await open();
    assert.equal(await signIn(rebuilt, PASSWORD), 200);
    assert.notEqual(await signIn(rebuilt, NEW_PASSWORD), 200);
    const events = await rebuilt.rows(securityTables.events);
    const rebuild = events.filter((event) => event.kind === "identity.import_rebuilt");
    assert.equal(rebuild.length, 1);
    assert.equal(rebuild[0].detail.previous, role === "project" ? "resetting" : "done");
    assert.equal(events.filter((event) => event.kind === "identity.imported").length, 1, "only the rebuilt import's summary remains");
    const [state] = await rebuilt.rows(importTables.state);
    assert.equal(state.status, "done");
    assert.equal(state.sourceFingerprint, await run(options.importFrom.fingerprint()));
  });
}
