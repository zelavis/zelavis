import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  createDatabaseAuthRepositories,
  createIdentity,
  createInMemoryAuthRepositories,
  createPasswordProvider,
  decodeRegistrationControl,
  defineAuthEndpointGroup,
} from "../dist/app/identity/index.js";
import { createPlatformAuthRepositories } from "../dist/platform/auth-repositories.js";
import { createMemorySystemStore, Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { createProjectIdentityEndpointGroup } from "../dist/app/app-service.js";

const backends = {
  memory: () => createInMemoryAuthRepositories(),
  "Platform System Store": () => createPlatformAuthRepositories(createMemorySystemStore()),
  "Project database": async (t) => createDatabaseAuthRepositories((await openTemporaryDatabase(t)).api),
};

const password = "my long unique registration password";
const preparePassword = createPasswordProvider({ iterations: 100_000 }).prepareCredential;
const clock = () => new Date(Math.floor(Date.now() / 60_000) * 60_000);
const hasTag = (_tag) => (error) => error._tag === _tag;

test("App password enrollment, rotation and logout use the exact Project session cookie", async (t) => {
  const origin = "https://site.example.org";
  const rootPath = "/ops/identity";
  const projectId = "site-é";
  const audience = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
  const cookieName = `zelavis_app_${audience}`;
  const composeProject = async (id, sessionCookie) => createServiceRuntime({ endpointGroups: [
    await createProjectIdentityEndpointGroup({
      database: (await openTemporaryDatabase(t)).api, registry: [], methods: [], projectId: id, rootPath,
      options: { registration: true, definition: { sessionCookie } },
    }),
  ] });
  const project = await composeProject(projectId);
  const sibling = await composeProject("sibling");
  const headless = await composeProject("headless", false);
  const platformIdentity = await compose(undefined, { authority: "platform", initiallyEnabled: true, enrollmentReady: () => true });
  const platform = await createServiceRuntime({ endpointGroups: [defineAuthEndpointGroup(platformIdentity, { sessionCookie: { path: rootPath } })] });
  const credentials = { identifier: "same@example.org", password };
  const call = (runtime, path, method = "GET", headers = {}, body, requestOrigin = origin) => runtime.fetch(new Request(`${requestOrigin}/auth/${path}`, {
    method, headers: { origin: requestOrigin, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const signup = await call(project, "sign-up/password", "POST", {}, credentials);
  assert.equal(signup.status, 201);
  const { account, session } = await signup.json();
  assert.deepEqual(account.roles, ["user"]);
  assert.match(session.token, new RegExp(`^zvs_app_${audience}_[A-Za-z0-9_-]{43}$`));
  const issuedCookie = signup.headers.get("set-cookie");
  assert.ok(issuedCookie.startsWith(`${cookieName}=${session.token}; Path=${rootPath}; HttpOnly; SameSite=Lax; Secure; Max-Age=`));
  assert.doesNotMatch(issuedCookie, /Domain=/i);
  const cookie = issuedCookie.split(";", 1)[0];
  const platformSignup = await call(platform, "sign-up/password", "POST", {}, credentials);
  assert.equal(platformSignup.status, 201);
  const platformToken = (await platformSignup.json()).session.token;
  assert.match(platformToken, /^zvs_[A-Za-z0-9_-]{43}$/);
  assert.match(platformSignup.headers.get("set-cookie"), /^zelavis_session=/);
  for (const other of [platform, sibling]) {
    assert.equal((await call(other, "session", "GET", { cookie })).status, 401);
    assert.equal((await call(other, "session", "GET", { authorization: `Bearer ${session.token}` })).status, 401);
  }
  assert.equal((await call(project, "session", "GET", { authorization: `Bearer ${platformToken}` })).status, 401);
  assert.equal((await call(project, "session", "GET", { cookie })).status, 200);
  assert.equal((await call(project, "session/rotate", "POST", { cookie, origin: "https://other.example.org" })).status, 401);
  const rotated = await call(project, "session/rotate", "POST", { cookie });
  assert.equal(rotated.status, 200);
  const newCookie = rotated.headers.get("set-cookie").split(";", 1)[0];
  assert.match(newCookie, new RegExp(`^${cookieName}=zvs_app_${audience}_[A-Za-z0-9_-]{43}$`));
  assert.equal((await call(project, "session", "GET", { cookie })).status, 401);
  const logout = await call(project, "session", "DELETE", { cookie: newCookie });
  assert.equal(logout.status, 204);
  assert.equal(logout.headers.get("set-cookie"), `${cookieName}=; Path=${rootPath}; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
  const login = await call(project, "authenticate/password", "POST", {}, credentials, "http://127.0.0.1:4000");
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.headers.get("set-cookie"), /Secure/);
  const headlessSignup = await call(headless, "sign-up/password", "POST", {}, credentials);
  assert.equal(headlessSignup.status, 201);
  assert.equal(headlessSignup.headers.get("set-cookie"), null);
  const headlessToken = (await headlessSignup.json()).session.token;
  assert.equal((await call(headless, "session", "GET", { authorization: `Bearer ${headlessToken}` })).status, 200);
});

function compose(repositories, options = {}, provider = {}) {
  return createIdentity({
    repositories,
    registration: options,
    methods: [{
      name: "password",
      register(auth) {
        auth.authentication.registerProvider({ ...createPasswordProvider({ iterations: 100_000 }), ...provider });
      },
    }],
  });
}

for (const [name, backend] of Object.entries(backends)) {
  test(`${name}: policy CAS, duplicate enrollment and existing sign-in`, async (t) => {
    const repositories = await backend(t);
    let ready = false;
    const options = { authority: "platform", enrollmentReady: () => Promise.resolve(ready) };
    const auth = await compose(repositories, options);
    assert.deepEqual(await auth.registration.status(), { enabled: false, providers: [] });
    assert.deepEqual(await auth.registration.setSettings({ enabled: true, expectedRevision: 0 }), { enabled: true, revision: 1 });
    await assert.rejects(auth.registration.signUp("password", { identifier: "owner@example.org", password }), hasTag("RegistrationClosed"));
    ready = true;
    assert.deepEqual(await auth.registration.status(), { enabled: true, providers: ["password"] });
    await assert.rejects(auth.registration.setSettings({ enabled: false, expectedRevision: 0 }), hasTag("RegistrationSettingsConflict"));
    await assert.rejects(auth.registration.setSettings({ enabled: false, expectedRevision: 1, scope: "system" }), /Invalid registration settings/);
    assert.deepEqual(await auth.registration.setSettings({ enabled: true, expectedRevision: 1 }), { enabled: true, revision: 1 });
    await assert.rejects(auth.registration.signUp("password", { identifier: "one", password, roles: ["owner"] }), /Invalid registration input/);

    const outcomes = await Promise.allSettled(["one@example.org", " ONE@example.org "].map((identifier) =>
      auth.registration.signUp("password", { identifier, password, displayName: " One " })));
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled").value;
    const loser = outcomes.find((outcome) => outcome.status === "rejected").reason;
    assert.equal(loser._tag, "RegistrationConflict");
    assert.deepEqual(winner.account.roles, ["customer"]);
    assert.deepEqual(winner.account.grants, []);
    assert.deepEqual(winner.account.permissions, []);
    assert.equal(winner.account.displayName, "One");
    assert.equal(winner.account.verified, false);
    assert.equal(winner.account.registrationPending, undefined);
    assert.equal((await repositories.accounts.list()).length, 1);
    assert.equal((await repositories.credentials.listByAccountId(winner.account.id)).length, 1);
    assert.deepEqual((await repositories.registration.read()).slots, []);

    await auth.registration.setSettings({ enabled: false, expectedRevision: 1 });
    const next = await compose(repositories, { ...options, initiallyEnabled: true });
    assert.deepEqual(await next.registration.settings(), { enabled: false, revision: 2 });
    assert.equal((await next.authentication.authenticate("password", { identifier: "one@example.org", password })).account.id, winner.account.id);
  });

  for (const [point, phase] of Object.entries({
    reservation: "reserved",
    account: "reserved",
    credential: "reserved",
    commit: "committed",
    activation: "committed",
    retirement: undefined,
    session: undefined,
  })) {
    test(`${name}: recover after interrupted ${point}`, async (t) => {
      const repositories = await backend(t);
      const { registration, accounts, credentials, sessions } = repositories;
      let failure = false;
      let ids;
      const interrupt = () => { failure = true; throw new Error("Simulated loss of writer"); };
      const auth = await compose({
        ...repositories,
        registration: {
          read: () => failure ? Promise.reject(new Error("Writer fenced")) : registration.read(),
          async mutate(mutate) {
            const record = await registration.mutate(mutate);
            if (record?.slots[0]) ids = record.slots[0];
            if (point === "reservation" && record?.slots[0]?.phase === "reserved" ||
                point === "commit" && record?.slots[0]?.phase === "committed" ||
                point === "retirement" && record?.slots.length === 0) interrupt();
            return record;
          },
        },
        accounts: {
          ...accounts,
          async create(account) {
            const saved = await accounts.create(account);
            if (point === "account") interrupt();
            return saved;
          },
          async mutate(id, mutate) {
            const saved = await accounts.mutate(id, mutate);
            if (point === "activation") interrupt();
            return saved;
          },
        },
        credentials: {
          ...credentials,
          async create(credential) {
            const saved = await credentials.create(credential);
            if (point === "credential") interrupt();
            return saved;
          },
        },
        sessions: {
          create: (session) => point === "session" ? Promise.reject(new Error("Session store failed")) : sessions.create(session),
        },
      }, { initiallyEnabled: true });
      const input = { identifier: "interrupt", password };
      await assert.rejects(auth.registration.signUp("password", input), hasTag("RegistrationUnavailable"));
      assert.ok(ids);
      assert.equal((await registration.read()).slots[0]?.phase, phase);
      const saved = await accounts.findById(ids.accountId);
      if (saved?.registrationPending) {
        assert.equal(await auth.accounts.findById(saved.id), null);
        await assert.rejects(auth.sessions.create({ accountId: saved.id, expiresAt: new Date(Date.now() + 60_000) }), /unavailable/);
        await assert.rejects(auth.authentication.authenticate("password", input), /Invalid credentials/);
      }

      const next = await compose(repositories, { initiallyEnabled: false });
      assert.deepEqual((await registration.read()).slots, []);
      assert.equal((await registration.read()).windowAttempts, 1);
      assert.equal((await next.registration.status()).enabled, true);
      if (phase === "reserved") {
        assert.equal(await accounts.findById(ids.accountId), null);
        assert.equal(await credentials.findById(ids.credentialId), null);
        assert.equal((await next.registration.signUp("password", input)).account.username, input.identifier);
      } else {
        assert.equal((await accounts.findById(ids.accountId)).registrationPending, undefined);
        assert.equal((await credentials.findById(ids.credentialId)).accountId, ids.accountId);
        assert.equal((await next.authentication.authenticate("password", input)).account.id, ids.accountId);
      }
    });
  }
}

test("disable orders before an outstanding signup commit and bounds simultaneous reservations", async () => {
  const repositories = createInMemoryAuthRepositories();
  const allAdmitted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let preparing = 0;
  const auth = await compose(repositories, { initiallyEnabled: true }, {
    async prepareCredential(input) {
      if (++preparing === 8) allAdmitted.resolve();
      await release.promise;
      return preparePassword(input);
    },
  });
  const operations = Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    auth.registration.signUp("password", { identifier: `user-${index}`, password })));
  await allAdmitted.promise;
  assert.equal((await repositories.registration.read()).slots.length, 8);
  const runtime = await createServiceRuntime({ endpointGroups: [defineAuthEndpointGroup(auth)] });
  const busy = await runtime.plain({
    method: "POST", url: "/auth/sign-up/password", body: { identifier: "ninth", password },
  });
  assert.equal(busy.status, 429);
  assert.equal(busy.body.code, "registration_busy");
  assert.equal(busy.headers["retry-after"], "1");
  await auth.registration.setSettings({ enabled: false, expectedRevision: 0 });
  await auth.registration.setSettings({ enabled: true, expectedRevision: 1 });
  release.resolve();
  const results = await operations;
  assert.ok(results.every((result) => result.status === "rejected" && result.reason._tag === "RegistrationClosed"));
  assert.equal((await repositories.accounts.list()).length, 0);
  assert.deepEqual((await repositories.registration.read()).slots, []);
});

test("registration counts admitted attempts per minute independently of sign-in", async () => {
  const repositories = createInMemoryAuthRepositories();
  let now = clock();
  const first = await compose(repositories, { initiallyEnabled: true, now: () => now });
  const input = { identifier: "existing", password };
  const enrolled = await first.registration.signUp("password", input);
  const auth = await compose(repositories, { now: () => now }, {
    prepareCredential() { throw new TypeError("Cannot prepare test credential"); },
  });
  for (let attempt = 1; attempt < 60; attempt++) {
    await assert.rejects(auth.registration.signUp("password", input), /Invalid registration input/);
  }
  const runtime = await createServiceRuntime({ endpointGroups: [defineAuthEndpointGroup(auth)] });
  const limited = await runtime.plain({ method: "POST", url: "/auth/sign-up/password", body: input });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "registration_rate_limited");
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal((await auth.authentication.authenticate("password", input)).account.id, enrolled.account.id);
  now = new Date(now.getTime() + 60_000);
  await assert.rejects(auth.registration.signUp("password", input), /Invalid registration input/);
  assert.equal((await repositories.registration.read()).windowAttempts, 1);
});

test("invalid persisted registration state fails closed and existing credentials still work", async () => {
  const store = createMemorySystemStore();
  const repositories = createPlatformAuthRepositories(store);
  const auth = await compose(repositories, { initiallyEnabled: true });
  const input = { identifier: "existing", password };
  const { account } = await auth.registration.signUp("password", input);
  const control = await repositories.registration.read();
  const slot = { accountId: "account_one", credentialId: "credential_one", phase: "reserved", policyRevision: 0 };
  for (const invalid of [
    { ...control, slots: [slot, slot] },
    { ...control, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...control, slots: [{ ...slot, phase: "unknown" }] },
    { ...control, slots: [{ ...slot, policyRevision: 1 }] },
    { ...control, windowAttempts: 61 },
    { ...control, windowStartMs: 1 },
    { ...control, extra: true },
  ]) assert.throws(() => decodeRegistrationControl(invalid));

  await store.set("zelavis.platform.auth", "registration", { ...control, slots: [slot, slot] });
  const next = await compose(repositories);
  await assert.rejects(next.registration.status(), hasTag("RegistrationUnavailable"));
  await assert.rejects(next.registration.signUp("password", input), hasTag("RegistrationUnavailable"));
  assert.equal((await next.authentication.authenticate("password", input)).account.id, account.id);
});

test("a committed slot stays committed across a disable and an ambiguous reply", async () => {
  const repositories = createInMemoryAuthRepositories();
  const committed = Promise.withResolvers();
  const disabled = Promise.withResolvers();
  const registration = repositories.registration;
  const auth = await compose({
    ...repositories,
    registration: {
      read: () => registration.read(),
      async mutate(mutation) {
        const result = await registration.mutate(mutation);
        if (result.enabled && result.slots[0]?.phase === "committed") {
          committed.resolve();
          await disabled.promise;
          throw new Error("Commit response lost");
        }
        return result;
      },
    },
  }, { initiallyEnabled: true });
  const enrollment = auth.registration.signUp("password", { identifier: "committed", password });
  await committed.promise;
  await auth.registration.setSettings({ enabled: false, expectedRevision: 0 });
  disabled.resolve();
  const { account } = await enrollment;
  assert.equal((await auth.accounts.findById(account.id)).registrationPending, undefined);
  assert.deepEqual(await auth.registration.status(), { enabled: false, providers: [] });
  assert.deepEqual((await registration.read()).slots, []);
});

test("failed compensation stays recoverable and closes admission until recovery", async () => {
  const repositories = createInMemoryAuthRepositories();
  const credentials = repositories.credentials;
  const accounts = repositories.accounts;
  const auth = await compose({
    ...repositories,
    credentials: {
      ...credentials,
      async create(input) {
        await credentials.create(input);
        throw new Error("Credential response lost");
      },
    },
    accounts: {
      ...accounts,
      delete: () => Promise.reject(new Error("Account cleanup unavailable")),
    },
  }, { initiallyEnabled: true });
  const input = { identifier: "cleanup", password };
  await assert.rejects(auth.registration.signUp("password", input), hasTag("RegistrationUnavailable"));
  const { slots: [slot] } = await repositories.registration.read();
  assert.equal(slot.phase, "reserved");
  assert.equal(await credentials.findById(slot.credentialId), null);
  assert.equal((await accounts.findById(slot.accountId)).registrationPending, true);
  await assert.rejects(auth.registration.status(), hasTag("RegistrationUnavailable"));
  const recovered = await compose(repositories);
  assert.deepEqual((await repositories.registration.read()).slots, []);
  assert.equal((await recovered.registration.signUp("password", input)).account.username, input.identifier);
});

test("seeded enrollment transitions agree with a policy and recovery model", async () => {
  const seed = 0x1c62ad;
  let random = seed;
  let enabled = false;
  let revision = 0;
  let admitted = 0;
  let sequence = 0;
  let now = clock();
  const repositories = createInMemoryAuthRepositories();
  const registration = repositories.registration;
  const trace = [];
  const config = { now: () => now };
  let auth = await compose(repositories, config);
  try {
    for (let step = 0; step < 80; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const action = (random >>> 24) % 6;
      trace.push(action);
      if (action === 0) {
        enabled = !enabled;
        await auth.registration.setSettings({ enabled, expectedRevision: revision++ });
      } else if (action === 1) {
        now = new Date(now.getTime() + 60_000);
        admitted = 0;
      } else if (action === 2) {
        auth = await compose(repositories, config);
      } else if (action === 3) {
        const identity = { identifier: `subject-${sequence++}` };
        if (enabled) {
          await auth.registration.enrollPrepared("oidc", identity);
          admitted++;
        } else {
          await assert.rejects(auth.registration.enrollPrepared("oidc", identity), hasTag("RegistrationClosed"));
        }
      } else {
        const control = await registration.read();
        if (!control || !enabled) continue;
        const slot = {
          accountId: `staged-account-${sequence}`,
          credentialId: `staged-credential-${sequence++}`,
          policyRevision: revision,
          phase: action === 4 ? "reserved" : "committed",
        };
        const account = await auth.accounts.create({ id: slot.accountId, username: slot.accountId }, { registrationPending: true });
        await auth.credentials.create({ id: slot.credentialId, accountId: account.id, provider: "oidc", identifier: slot.credentialId });
        admitted++;
        await registration.mutate((record) => ({ ...record, windowStartMs: now.getTime(), windowAttempts: admitted, slots: [slot] }));
        auth = await compose(repositories, config);
        assert.equal(Boolean(await auth.accounts.findById(account.id)), action === 5);
        assert.equal(Boolean(await auth.credentials.findById(slot.credentialId)), action === 5);
      }
      assert.deepEqual(await auth.registration.settings(), { enabled, revision });
      const control = await registration.read();
      assert.deepEqual(control?.slots ?? [], []);
      if (control?.windowStartMs === now.getTime()) assert.equal(control.windowAttempts, admitted);
    }
  } catch (cause) {
    throw new Error(`Seed ${seed}, operations ${trace.join(",")}`, { cause });
  }
});

test("two native Apps and their Platform persist independent signup policies and sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-registration-"));
  const bootstrapToken = "native-registration-bootstrap-token-long-enough";
  const platformOrigin = "http://registration-platform.test";
  const createPlatform = () => new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }),
    bootstrap: { token: bootstrapToken },
  });
  let zv = createPlatform();
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const through = (input, init) => zv.fetch(new Request(input, init));
  const platformClient = (token) => createZelavisClient({
    baseUrl: platformOrigin,
    fetch: through,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const publicPlatform = platformClient();
  const { session: ownerSession } = await publicPlatform.auth.bootstrap({
    bootstrapToken,
    provider: "password",
    account: { username: "owner" },
    credential: { identifier: "owner", password },
  });
  const owner = platformClient(ownerSession.token);
  const closed = { enabled: false, providers: [] };
  const open = { enabled: true, providers: ["password"] };
  const enable = { enabled: true, expectedRevision: 0 };
  const one = await owner.projects.create({ id: "registration-one", name: "One", recipeName: "@zelavis/app" });
  const two = await owner.projects.create({ id: "registration-two", name: "Two", recipeName: "@zelavis/app" });
  const native = (project, token) => createZelavisClient({
    baseUrl: project.runtime.url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  let appOne = native(one);
  const appTwo = native(two);
  assert.deepEqual(await publicPlatform.auth.registrationStatus(), closed);
  assert.deepEqual(await appOne.auth.registrationStatus(), closed);
  assert.deepEqual(await appTwo.auth.registrationStatus(), closed);

  const { token: settingsToken } = await owner.auth.admin.createServiceAccount({
    name: "Signup delegate",
    grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: one.id } }],
  });
  const delegate = platformClient(settingsToken);
  const runProjectCli = async (args) => {
    const fetch = globalThis.fetch;
    const log = console.log;
    const lines = [];
    globalThis.fetch = (input, init) => new URL(input instanceof Request ? input.url : String(input)).origin === platformOrigin
      ? through(input, init)
      : fetch(input, init);
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await runProjectsCommand([...args, "--url", `${platformOrigin}/zelavis`, "--token", settingsToken, "--json"]);
    } finally {
      globalThis.fetch = fetch;
      console.log = log;
    }
    return JSON.parse(lines.join("\n"));
  };
  assert.deepEqual(await runProjectCli(["registration-settings", one.id]), { enabled: false, revision: 0 });
  assert.deepEqual(await runProjectCli(["set-registration-settings", one.id, "--data", JSON.stringify(enable)]), { enabled: true, revision: 1 });
  assert.deepEqual(await delegate.projects.registrationSettings(one.id), { enabled: true, revision: 1 });
  await assert.rejects(delegate.projects.setRegistrationSettings(one.id, enable), { status: 409 });
  await assert.rejects(delegate.projects.registrationSettings(two.id), { status: 403 });
  await assert.rejects(delegate.projects.setRegistrationSettings(two.id, enable), { status: 403 });
  await assert.rejects(delegate.auth.admin.registrationSettings(), { status: 403 });
  assert.deepEqual(await appOne.auth.registrationStatus(), open);
  assert.deepEqual(await appTwo.auth.registrationStatus(), closed);
  assert.deepEqual(await publicPlatform.auth.registrationStatus(), closed);

  await owner.projects.setRegistrationSettings(two.id, enable);
  await owner.auth.admin.setRegistrationSettings(enable);
  const input = { identifier: "shared@example.com", password };
  const browser = await through(`${platformOrigin}/zelavis/api/v1/auth/sign-up/password`, {
    method: "POST", headers: { "content-type": "application/json", origin: platformOrigin }, body: JSON.stringify(input),
  });
  assert.equal(browser.status, 201);
  assert.equal(browser.headers.get("cache-control"), "no-store");
  assert.match(browser.headers.get("set-cookie"), /HttpOnly/);
  const customer = await browser.json();
  const a = await appOne.auth.signUpWithPassword(input);
  const b = await appTwo.auth.signUpWithPassword(input);
  assert.equal(new Set([a.account.id, b.account.id, customer.account.id]).size, 3);
  for (const entry of [a, b]) {
    assert.deepEqual(entry.account.roles, ["user"]);
    assert.deepEqual(entry.account.grants, []);
  }
  assert.deepEqual(customer.account.roles, ["customer"]);
  await assert.rejects(platformClient(customer.session.token).projects.get(one.id), { status: 403 });
  assert.equal((await owner.auth.bootstrapStatus()).required, false);
  await assert.rejects(native(two, a.session.token).auth.getSession(), { status: 401 });
  await assert.rejects(platformClient(a.session.token).auth.getSession(), { status: 401 });

  const restarted = await owner.projects.restart(one.id);
  appOne = native(restarted);
  assert.deepEqual(await owner.projects.registrationSettings(one.id), { enabled: true, revision: 1 });
  assert.deepEqual(await appOne.auth.registrationStatus(), open);
  assert.equal((await appOne.auth.signInWithPassword(input)).account.id, a.account.id);
  await owner.projects.setRegistrationSettings(one.id, { enabled: false, expectedRevision: 1 });
  assert.deepEqual(await appOne.auth.registrationStatus(), closed);
  await assert.rejects(appOne.auth.signUpWithPassword(input), { status: 403 });
  assert.equal((await appOne.auth.signInWithPassword(input)).account.id, a.account.id);
  assert.deepEqual(await appTwo.auth.registrationStatus(), open);

  await zv.close();
  zv = createPlatform();
  assert.deepEqual(await owner.auth.admin.registrationSettings(), { enabled: true, revision: 1 });
  assert.equal((await publicPlatform.auth.signInWithPassword(input)).account.id, customer.account.id);
});

test("a custom account store without registration persistence leaves enrollment unavailable", async () => {
  const { accounts } = createInMemoryAuthRepositories();
  const auth = await compose({ accounts }, { initiallyEnabled: true });
  await assert.rejects(auth.registration.settings(), hasTag("RegistrationUnavailable"));
  await assert.rejects(auth.registration.setSettings({ enabled: true, expectedRevision: 0 }), hasTag("RegistrationUnavailable"));
  await assert.rejects(auth.registration.status(), hasTag("RegistrationUnavailable"));
  const account = await auth.accounts.create({ id: "existing", username: "existing" });
  assert.equal((await auth.accounts.findById(account.id)).username, "existing");
});

test("generic enrollment preserves bounded provider input and assigns only safe account fields", async () => {
  const auth = await compose(createInMemoryAuthRepositories(), { initiallyEnabled: true });
  let prepared = 0;
  auth.authentication.registerProvider({
    name: "example",
    async prepareCredential(input) {
      prepared++;
      assert.equal(input.identifier, "subject");
      assert.equal(input.profile.id, "provider-owned");
      return {
        identifier: input.identifier,
        secretHash: "provider-owned-secret-hash",
        accountIdentity: { username: "user", roles: ["owner"], grants: ["*"], verified: true },
      };
    },
  });
  await assert.rejects(auth.registration.signUp("example", { identifier: "subject", tenantId: "foreign" }), /Invalid registration input/);
  assert.equal(prepared, 0);
  const result = await auth.registration.signUp("example", {
    identifier: " subject ", displayName: " New user ", profile: { id: "provider-owned" },
  });
  assert.equal(prepared, 1);
  assert.equal(result.account.username, "user");
  assert.equal(result.account.displayName, "New user");
  assert.equal(result.account.verified, false);
  assert.deepEqual(result.account.roles, ["user"]);
  assert.deepEqual(result.account.grants, []);
  assert.deepEqual(result.account.permissions, []);
});

for (const withStore of [true, false]) {
  test(`in-process recomposition leaves a live enrollment with its writer (${withStore ? "supplied" : "default"} store)`, async (t) => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const bootstrapToken = "registration-recomposition-bootstrap-token";
    const catalog = [{
      service: {
        name: "@test/registration-provider",
        kind: "plugin",
        capabilities: ["zelavis/identity:credentials"],
        service: {
          name: "delayed",
          register(auth) {
            auth.authentication.registerProvider({
              name: "delayed",
              async prepareCredential(input) {
                started.resolve();
                await release.promise;
                return preparePassword(input);
              },
            });
          },
        },
      },
      source: "official",
      status: "installed",
    }];
    const resources = withStore ? { systemStore: createMemorySystemStore() } : {};
    const app = new Zelavis({
      bootstrap: { token: bootstrapToken },
      adapter: { name: "registration-test", resolve: () => ({ serviceRegistry: { catalog }, resources }) },
    });
    t.after(() => app.close());
    const through = (input, init) => app.fetch(new Request(input, init));
    const client = createZelavisClient({ baseUrl: "http://localhost", fetch: through });
    const { session: owner } = await client.auth.bootstrap({
      bootstrapToken,
      provider: "password",
      account: { username: "owner" },
      credential: { identifier: "owner", password },
    });
    const admin = createZelavisClient({
      baseUrl: "http://localhost", fetch: through, headers: { authorization: `Bearer ${owner.token}` },
    });
    await admin.auth.admin.setRegistrationSettings({ enabled: true, expectedRevision: 0 });

    const previous = await app.runtime();
    const enrollment = client.auth.signUp("delayed", { identifier: "signup-during-recompose", password });
    try {
      await Promise.race([started.promise, enrollment]);
      const activated = await through("http://localhost/zelavis/api/v1/runtime/services", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({
          name: "@test/recompose",
          specifier: "data:text/javascript," + encodeURIComponent('export default { name: "@test/recompose", version: "1.0.0", kind: "plugin" };'),
          status: "installed",
        }),
      });
      assert.equal(activated.status, 201, await activated.text());
      assert.notEqual(await app.runtime(), previous);
      assert.deepEqual(await admin.auth.admin.registrationSettings(), { enabled: true, revision: 1 });
    } finally {
      release.resolve();
      await enrollment.catch(() => undefined);
    }
    const { account } = await enrollment;
    assert.equal(account.username, "signup-during-recompose");
    assert.equal((await admin.auth.admin.accounts()).filter((item) => item.id === account.id).length, 1);
  });
}
