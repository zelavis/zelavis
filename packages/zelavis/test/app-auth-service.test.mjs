import assert from "node:assert/strict";
import test from "node:test";
import { createAuth, defineAuthService } from "../dist/app/auth/index.js";

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
