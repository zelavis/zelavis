import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuth,
  createDatabaseAuthRepositories,
  defineAuthService,
  AuthInvalidCredentialsError,
  hashPassword,
  verifyPassword,
} from "../dist/app/auth/index.js";
import { createDatabase } from "../dist/app/db/index.js";
import {
  createBasicAuthenticator,
  createJwtAuthenticator,
  createServiceRuntime,
} from "../dist/core/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { generateKeyPair, SignJWT } from "jose";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

function passwordMethodService() {
  const method = {
    name: "email-password",
    register(api) {
      api.authentication.registerProvider({
        name: "email-password",
        async prepareCredential(input) {
          return {
            identifier: input.identifier.trim().toLowerCase(),
            secretHash: await hashPassword(input.password, { iterations: 100_000 }),
            accountIdentity: { email: input.identifier.trim().toLowerCase() },
          };
        },
        async authenticate(input, providerApi) {
          const identifier = input.identifier.trim().toLowerCase();
          const credential = await providerApi.credentials.findByProviderIdentifier(
            "email-password",
            identifier,
          );
          if (!credential?.secretHash || !await verifyPassword(input.password, credential.secretHash)) {
            throw new AuthInvalidCredentialsError();
          }
          const account = await providerApi.accounts.findById(credential.accountId);
          if (!account) throw new AuthInvalidCredentialsError();
          return {
            account,
            credential,
            session: await providerApi.sessions.create({
              accountId: account.id,
              expiresAt: new Date(Date.now() + 60_000),
              metadata: { provider: "email-password" },
            }),
          };
        },
      });
    },
  };
  return {
    name: "@example/auth-email-password",
    kind: "provider",
    capabilities: ["zelavis/auth:credentials"],
    service: method,
  };
}

test("authService returns 400 for invalid account creation input", async () => {
  const auth = await createAuth();
  const service = defineAuthService(auth);
  const createAccount = service.api.v1.find(
    (route) => route.id === "auth.accounts.create",
  );

  const response = await createAccount.handler({
    service: auth,
    params: {},
    query: new URLSearchParams(),
    body: {
      id: "account_1",
    },
    headers: {},
    request: undefined,
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /email or username/);
});

test("authService returns 404 for unknown authentication providers", async () => {
  const auth = await createAuth();
  const service = defineAuthService(auth);
  const authenticate = service.api.v1.find(
    (route) => route.id === "auth.authenticate",
  );

  const response = await authenticate.handler({
    service: auth,
    params: {
      provider: "missing-provider",
    },
    query: new URLSearchParams(),
    body: {
      identifier: "demo",
      password: "secret",
    },
    headers: {},
    request: undefined,
  });

  assert.equal(response.status, 404);
  assert.match(response.body.error, /Unknown authentication provider/);
});

test("authentication attempts are bounded and produce privacy-safe audit events", async () => {
  const auth = await createAuth({
    methods: [passwordMethodService().service],
    security: { maxAttempts: 2, windowMs: 60_000, blockMs: 60_000 },
  });
  await auth.accounts.create({ id: "account_1", email: "ivan@example.com" });
  await auth.credentials.create({
    id: "credential_1",
    accountId: "account_1",
    provider: "email-password",
    identifier: "ivan@example.com",
    secretHash: await hashPassword("correct password", { iterations: 100_000 }),
  });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  for (let index = 0; index < 2; index += 1) {
    const failure = await runtime.plain({
      url: "/auth/authenticate/email-password",
      method: "POST",
      body: { identifier: "ivan@example.com", password: "wrong password" },
    });
    assert.equal(failure.status, 401);
  }
  const blocked = await runtime.plain({
    url: "/auth/authenticate/email-password",
    method: "POST",
    body: { identifier: "ivan@example.com", password: "correct password" },
  });
  assert.equal(blocked.status, 429);
  assert.equal(Number(blocked.headers["retry-after"]) > 0, true);

  const eventsResponse = await runtime.plain({
    url: "/auth/security/events",
    principal: {
      id: "administrator",
      type: "user",
      permissions: ["project.users.manage"],
    },
  });
  assert.equal(eventsResponse.status, 200);
  assert.deepEqual(
    eventsResponse.body.events.map((event) => event.outcome).sort(),
    ["blocked", "failure", "failure"],
  );
  assert.equal(JSON.stringify(eventsResponse.body).includes("ivan@example.com"), false);
});

test("credential recovery is provider-owned, endpoint-backed, and revokes sessions", async () => {
  let deliveredToken;
  const recoveryMethod = {
    name: "recovery-test",
    register(api) {
      api.authentication.registerProvider({
        name: "recovery-test",
        async authenticate() { throw new AuthInvalidCredentialsError(); },
        async beginRecovery(input, providerApi) {
          const credential = await providerApi.credentials.findByProviderIdentifier(
            "recovery-test",
            input.identifier,
          );
          if (credential) deliveredToken = "one-time-token";
          return { accepted: true };
        },
        async completeRecovery(input, providerApi) {
          if (input.token !== deliveredToken) throw new AuthInvalidCredentialsError();
          const credential = await providerApi.credentials.findByProviderIdentifier(
            "recovery-test",
            input.identifier,
          );
          await providerApi.credentials.update({
            ...credential,
            secretHash: "recovered",
            updatedAt: new Date(),
          });
          await providerApi.sessions.revokeAll(credential.accountId);
        },
      });
    },
  };
  const auth = await createAuth({ methods: [recoveryMethod] });
  await auth.accounts.create({ id: "account_1", email: "ivan@example.com" });
  await auth.credentials.create({
    id: "credential_1",
    accountId: "account_1",
    provider: "recovery-test",
    identifier: "ivan@example.com",
    secretHash: "old",
  });
  const session = await auth.sessions.create({
    accountId: "account_1",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  const started = await runtime.plain({
    url: "/auth/recovery/recovery-test",
    method: "POST",
    body: { identifier: "ivan@example.com" },
  });
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { accepted: true });
  const completed = await runtime.plain({
    url: "/auth/recovery/recovery-test/complete",
    method: "POST",
    body: {
      identifier: "ivan@example.com",
      token: deliveredToken,
      password: "new password",
    },
  });
  assert.equal(completed.status, 204);
  assert.equal((await auth.credentials.findById("credential_1")).secretHash, "recovered");
  assert.equal((await auth.sessions.findById(session.session.id)).status, "revoked");
});

test("Authorization Code login binds PKCE, state, nonce, and explicit account linking", async () => {
  const exchanges = [];
  const method = {
    name: "oidc-test",
    register(api) {
      api.authentication.registerProvider({
        name: "oidc-test",
        authorizationCode: {
          redirectUri: "http://localhost/auth/oauth/oidc-test/callback",
          createAuthorizationUrl(input) {
            const url = new URL("https://identity.example/authorize");
            for (const [key, value] of Object.entries(input)) {
              url.searchParams.set(key, value);
            }
            return url;
          },
          async exchange(input) {
            exchanges.push(input);
            return {
              identifier: input.code,
              email: `${input.code}@example.com`,
              verified: true,
            };
          },
        },
      });
    },
  };
  const auth = await createAuth({ methods: [method] });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  const started = await runtime.plain({
    url: "/auth/oauth/oidc-test/start",
    method: "POST",
  });
  assert.equal(started.status, 200);
  const authorizationUrl = new URL(started.body.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  assert.ok(authorizationUrl.searchParams.get("nonce"));
  assert.ok(authorizationUrl.searchParams.get("codeChallenge"));
  assert.equal(authorizationUrl.searchParams.has("codeVerifier"), false);

  const completed = await runtime.plain({
    url: `/auth/oauth/oidc-test/callback?state=${encodeURIComponent(state)}&code=subject-1`,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.account.email, "subject-1@example.com");
  assert.equal(completed.body.credential.provider, "oidc-test");
  assert.equal(exchanges[0].nonce, authorizationUrl.searchParams.get("nonce"));
  assert.notEqual(exchanges[0].codeVerifier, authorizationUrl.searchParams.get("codeChallenge"));

  const replayed = await runtime.plain({
    url: `/auth/oauth/oidc-test/callback?state=${encodeURIComponent(state)}&code=subject-1`,
  });
  assert.equal(replayed.status, 400);

  const target = await auth.accounts.create({
    id: "account_link_target",
    email: "target@example.com",
  });
  const linkStarted = await runtime.plain({
    url: "/auth/oauth/oidc-test/link/start",
    method: "POST",
    principal: { id: target.id, type: "user" },
  });
  assert.equal(linkStarted.status, 200);
  const linkState = new URL(linkStarted.body.authorizationUrl).searchParams.get("state");
  const linked = await runtime.plain({
    url: `/auth/oauth/oidc-test/callback?state=${encodeURIComponent(linkState)}&code=subject-linked`,
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.account.id, target.id);
  assert.equal(
    (await auth.credentials.findByProviderIdentifier("oidc-test", "subject-linked"))
      .accountId,
    target.id,
  );
});

test("auth administration requires the Project users permission", async () => {
  const auth = await createAuth();
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });
  const anonymous = await runtime.plain({ url: "/auth/accounts" });
  const unprivileged = await runtime.plain({
    url: "/auth/accounts",
    principal: { id: "user_1", type: "user" },
  });
  const administrator = await runtime.plain({
    url: "/auth/accounts",
    principal: {
      id: "admin_1",
      type: "user",
      permissions: ["project.users.manage"],
    },
  });

  assert.equal(anonymous.status, 401);
  assert.equal(unprivileged.status, 403);
  assert.equal(administrator.status, 200);
});

test("opaque sessions authenticate Bearer and cookie requests without storing raw tokens", async () => {
  const auth = await createAuth({ projectId: "petshop" });
  await auth.accounts.create({
    id: "account_1",
    username: "ivan",
    permissions: ["project.view"],
  });
  const issued = await auth.sessions.create({
    accountId: "account_1",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  assert.match(issued.token, /^zvs_/);
  assert.notEqual(issued.session.tokenHash, issued.token);
  const bearer = await runtime.plain({
    url: "/auth/session",
    headers: { authorization: `Bearer ${issued.token}` },
  });
  const cookie = await runtime.plain({
    url: "/auth/session",
    headers: { cookie: `zelavis_session=${issued.token}` },
  });

  assert.equal(bearer.status, 200);
  assert.equal(cookie.status, 200);
  assert.equal(bearer.body.principal.id, "account_1");
  assert.deepEqual(bearer.body.principal.grants, [
    { permission: "project.view", scope: { type: "project", projectId: "petshop" } },
  ]);

  const revoked = await runtime.plain({
    url: "/auth/session",
    method: "DELETE",
    headers: { authorization: `Bearer ${issued.token}` },
  });
  const afterRevoke = await runtime.plain({
    url: "/auth/session",
    headers: { authorization: `Bearer ${issued.token}` },
  });
  assert.equal(revoked.status, 204);
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.headers["www-authenticate"], "Bearer");
});

test("accounts and administrators can inspect and revoke device sessions", async () => {
  const auth = await createAuth();
  await auth.accounts.create({ id: "account_1", username: "ivan" });
  await auth.accounts.create({ id: "account_2", username: "other" });
  const current = await auth.sessions.create({
    accountId: "account_1",
    expiresAt: new Date(Date.now() + 60_000),
    metadata: { device: "laptop" },
  });
  const phone = await auth.sessions.create({
    accountId: "account_1",
    expiresAt: new Date(Date.now() + 60_000),
    metadata: { device: "phone" },
  });
  const other = await auth.sessions.create({
    accountId: "account_2",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const runtime = await createServiceRuntime({ services: [defineAuthService(auth)] });

  const listed = await runtime.plain({
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${current.token}` },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sessions.length, 2);
  assert.equal("tokenHash" in listed.body.sessions[0], false);
  assert.equal(listed.body.currentSessionId, current.session.id);

  const crossAccount = await runtime.plain({
    url: `/auth/sessions/${other.session.id}`,
    method: "DELETE",
    headers: { authorization: `Bearer ${current.token}` },
  });
  assert.equal(crossAccount.status, 404);

  const revokedPhone = await runtime.plain({
    url: `/auth/sessions/${phone.session.id}`,
    method: "DELETE",
    headers: { authorization: `Bearer ${current.token}` },
  });
  assert.equal(revokedPhone.status, 204);
  assert.equal((await auth.sessions.findById(phone.session.id)).status, "revoked");

  const revokedAll = await runtime.plain({
    url: "/auth/accounts/account_1/sessions",
    method: "DELETE",
    principal: {
      id: "administrator",
      type: "user",
      permissions: ["project.users.manage"],
    },
  });
  assert.equal(revokedAll.status, 200);
  assert.equal(revokedAll.body.revoked.length, 1);
  assert.equal((await auth.sessions.findById(current.session.id)).status, "revoked");
});

test("App Auth repositories persist accounts and sessions through the Tenant database boundary", async () => {
  const database = await createDatabase();
  const repositories = createDatabaseAuthRepositories(database, { tenantId: "tenant_auth" });
  const first = await createAuth({ repositories, projectId: "petshop" });
  await first.accounts.create({ id: "persistent", username: "persistent" });
  const issued = await first.sessions.create({
    accountId: "persistent",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const second = await createAuth({
    repositories: createDatabaseAuthRepositories(database, { tenantId: "tenant_auth" }),
    projectId: "petshop",
  });
  assert.equal((await second.accounts.findById("persistent")).id, "persistent");
  assert.equal((await second.sessions.resolveToken(issued.token)).accountId, "persistent");
});

test("App Auth attempt mutations use database optimistic concurrency", async () => {
  const database = await createDatabase();
  const first = createDatabaseAuthRepositories(database, { tenantId: "tenant_atomic" });
  const second = createDatabaseAuthRepositories(database, { tenantId: "tenant_atomic" });
  const keyHash = "atomic-subject";
  await first.attempts.mutate(keyHash, () => ({
    keyHash,
    failures: [],
    updatedAt: new Date(0),
  }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).attempts.mutate(keyHash, (current) => ({
        keyHash,
        failures: [...(current?.failures ?? []), new Date(index + 1)],
        updatedAt: new Date(index + 1),
      })),
    ),
  );

  const stored = await first.attempts.findByKeyHash(keyHash);
  assert.equal(stored.failures.length, 20);
  assert.deepEqual(
    stored.failures.map((failure) => failure.getTime()).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});

test("password hashing is salted and verifies through runtime-neutral Web Crypto", async () => {
  const first = await hashPassword("correct horse battery staple", { iterations: 100_000 });
  const second = await hashPassword("correct horse battery staple", { iterations: 100_000 });
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("Basic authentication is an optional native Request authenticator", async () => {
  const runtime = await createServiceRuntime({
    services: [{
      name: "protected",
      basePath: "/protected",
      service: {},
      authenticators: [createBasicAuthenticator({
        realm: "test",
        verify: ({ username, password }) =>
          username === "ivan" && password === "secret"
            ? { id: "ivan", type: "user" }
            : undefined,
      })],
      api: { v1: [{
        id: "protected.read",
        method: "GET",
        path: "/",
        access: { authenticated: true },
        handler: ({ principal }) => ({ body: principal }),
      }] },
    }],
  });
  const invalid = await runtime.plain({
    url: "/protected",
    headers: { authorization: `Basic ${btoa("ivan:wrong")}` },
  });
  const valid = await runtime.plain({
    url: "/protected",
    headers: { authorization: `Basic ${btoa("ivan:secret")}` },
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers["www-authenticate"], /^Basic /);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.id, "ivan");
});

test("Platform accounts and sessions use the System Store across runtime composition", async () => {
  const systemStore = createMemorySystemStore();
  const first = await zelavis({ systemStore });
  const created = await first.plain({
    url: "/zelavis/api/v1/auth/accounts",
    method: "POST",
    principal: { id: "owner", type: "system", permissions: ["*"] },
    body: {
      id: "owner",
      username: "owner",
      roles: ["owner"],
      permissions: ["*"],
    },
  });
  assert.equal(created.status, 201);
  await first.close();

  const second = await zelavis({ systemStore });
  const listed = await second.plain({
    url: "/zelavis/api/v1/auth/accounts",
    principal: { id: "owner", type: "system", permissions: ["*"] },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].id, "owner");
  await second.close();
});

test("Platform first-owner bootstrap, login, rotation, CSRF, and logout use real sessions", async () => {
  const systemStore = createMemorySystemStore();
  const bootstrapToken = "test-bootstrap-token-with-at-least-32-characters";
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    systemStore,
    bootstrap: { token: bootstrapToken },
    serviceRegistry: {
      catalog: [{
        service: passwordMethodService(),
        status: "installed",
        source: "official",
      }],
    },
  });

  const initial = await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
  });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.required, true);
  assert.equal(initial.body.available, true);
  assert.deepEqual(initial.body.providers, ["email-password"]);
  assert.deepEqual(initial.body.enrollmentProviders, ["email-password"]);

  const wrongToken = await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    body: {
      bootstrapToken: "wrong-bootstrap-token-with-at-least-32-characters",
      provider: "email-password",
      account: { email: "owner@example.com" },
      credential: {
        identifier: "owner@example.com",
        password: "correct horse battery staple",
      },
    },
  });
  assert.equal(wrongToken.status, 403);

  const bootstrapped = await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      bootstrapToken,
      provider: "email-password",
      account: { email: "owner@example.com", displayName: "Owner" },
      credential: {
        identifier: "owner@example.com",
        password: "correct horse battery staple",
      },
    },
  });
  assert.equal(bootstrapped.status, 201);
  assert.equal(bootstrapped.body.account.roles[0], "owner");
  assert.deepEqual(bootstrapped.body.account.permissions, ["*"]);
  assert.match(bootstrapped.headers["set-cookie"], /zelavis_session=zvs_/);
  assert.match(bootstrapped.headers["set-cookie"], /HttpOnly/);
  assert.match(bootstrapped.headers["set-cookie"], /Path=\/zelavis/);
  const firstCookie = bootstrapped.headers["set-cookie"].split(";", 1)[0];

  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { cookie: firstCookie },
  });
  assert.equal(access.status, 200);
  assert.equal(access.body.mode, "owner");
  assert.equal(access.body.principal.id, bootstrapped.body.account.id);

  const rejectedCsrf = await runtime.plain({
    url: "/zelavis/api/v1/auth/session/rotate",
    method: "POST",
    headers: { cookie: firstCookie },
  });
  assert.equal(rejectedCsrf.status, 403);

  const rotated = await runtime.plain({
    url: "/zelavis/api/v1/auth/session/rotate",
    method: "POST",
    headers: {
      cookie: firstCookie,
      origin: "http://localhost",
    },
  });
  assert.equal(rotated.status, 200);
  const rotatedCookie = rotated.headers["set-cookie"].split(";", 1)[0];
  assert.notEqual(rotatedCookie, firstCookie);
  assert.equal((await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { cookie: firstCookie },
  })).status, 401);

  const logout = await runtime.plain({
    url: "/zelavis/api/v1/auth/session",
    method: "DELETE",
    headers: {
      cookie: rotatedCookie,
      origin: "http://localhost",
    },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);

  const login = await runtime.plain({
    url: "/zelavis/api/v1/auth/authenticate/email-password",
    method: "POST",
    body: {
      identifier: "owner@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.status, 200);
  assert.match(login.body.session.token, /^zvs_/);
  assert.equal(login.headers["set-cookie"], undefined);

  const browserLogin = await runtime.plain({
    url: "/zelavis/api/v1/auth/authenticate/email-password",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      identifier: "owner@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(browserLogin.status, 200);
  assert.match(browserLogin.headers["set-cookie"], /zelavis_session=zvs_/);

  const duplicate = await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    body: {
      bootstrapToken,
      provider: "email-password",
      account: { email: "second@example.com" },
      credential: {
        identifier: "second@example.com",
        password: "another correct horse battery staple",
      },
    },
  });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error, /already complete/);

  await runtime.close();
});

test("a durable bootstrap claim admits only one Platform writer", async () => {
  const systemStore = createMemorySystemStore();
  const bootstrapToken = "concurrent-bootstrap-token-with-at-least-32-characters";
  const options = {
    systemStore,
    bootstrap: { token: bootstrapToken },
    serviceRegistry: {
      catalog: [{
        service: passwordMethodService(),
        status: "installed",
        source: "official",
      }],
    },
  };
  const [first, second] = await Promise.all([zelavis(options), zelavis(options)]);
  const input = (email) => ({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    body: {
      bootstrapToken,
      provider: "email-password",
      account: { email },
      credential: { identifier: email, password: "correct horse battery staple" },
    },
  });

  const responses = await Promise.all([
    first.plain(input("first@example.com")),
    second.plain(input("second@example.com")),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
  const accounts = await first.plain({
    url: "/zelavis/api/v1/auth/accounts",
    principal: { id: "owner", type: "system", permissions: ["*"] },
  });
  assert.equal(accounts.body.length, 1);
  await Promise.all([first.close(), second.close()]);
});

test("shared Platform Auth attempts update atomically across runtimes", async () => {
  const systemStore = createMemorySystemStore();
  const bootstrapToken = "atomic-attempt-bootstrap-token-with-32-characters";
  const options = {
    systemStore,
    bootstrap: { token: bootstrapToken },
    subsystems: {
      auth: {
        authOptions: {
          security: { maxAttempts: 4, windowMs: 60_000, blockMs: 60_000 },
        },
      },
    },
    serviceRegistry: {
      catalog: [{
        service: passwordMethodService(),
        status: "installed",
        source: "official",
      }],
    },
  };
  const [first, second] = await Promise.all([zelavis(options), zelavis(options)]);
  const created = await first.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    body: {
      bootstrapToken,
      provider: "email-password",
      account: { email: "atomic@example.com" },
      credential: {
        identifier: "atomic@example.com",
        password: "correct horse battery staple",
      },
    },
  });
  assert.equal(created.status, 201);

  const failures = await Promise.all(
    Array.from({ length: 4 }, (_, index) => (index % 2 === 0 ? first : second).plain({
      url: "/zelavis/api/v1/auth/authenticate/email-password",
      method: "POST",
      body: { identifier: "atomic@example.com", password: `wrong-${index}` },
    })),
  );
  assert.deepEqual(failures.map((response) => response.status), [401, 401, 401, 401]);

  const blocked = await second.plain({
    url: "/zelavis/api/v1/auth/authenticate/email-password",
    method: "POST",
    body: {
      identifier: "atomic@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(blocked.status, 429);
  await Promise.all([first.close(), second.close()]);
});

test("JWT authentication verifies signature, issuer, audience, and algorithm allow-list", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const token = await new SignJWT({ permissions: ["project.view"] })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject("account_jwt")
    .setIssuer("https://issuer.example")
    .setAudience("zelavis-test")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const runtime = await createServiceRuntime({
    services: [{
      name: "jwt-protected",
      basePath: "/jwt",
      service: {},
      authenticators: [createJwtAuthenticator({
        key: publicKey,
        issuer: "https://issuer.example",
        audience: "zelavis-test",
        algorithms: ["ES256"],
        mapPrincipal: (claims) =>
          claims.sub ? { id: claims.sub, type: "user" } : undefined,
      })],
      api: { v1: [{
        id: "jwt.read",
        method: "GET",
        path: "/",
        access: { authenticated: true },
        handler: ({ principal }) => ({ body: principal }),
      }] },
    }],
  });
  const valid = await runtime.plain({
    url: "/jwt",
    headers: { authorization: `Bearer ${token}` },
  });
  const invalid = await runtime.plain({
    url: "/jwt",
    headers: { authorization: "Bearer not.a.jwt" },
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.id, "account_jwt");
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers["www-authenticate"], /invalid_token/);
});
