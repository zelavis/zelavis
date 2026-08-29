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
  defineService,
} from "../dist/core/index.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { generateKeyPair, SignJWT } from "jose";

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
  return defineService({
    name: "@example/auth-email-password",
    kind: "provider",
    capabilities: ["provider:auth"],
    service: method,
  });
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
  const first = await zelavis({ systemStore, coreServices: { dashboard: false } });
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

  const second = await zelavis({ systemStore, coreServices: { dashboard: false } });
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
    systemStore,
    bootstrap: { token: bootstrapToken },
    coreServices: { dashboard: false },
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
