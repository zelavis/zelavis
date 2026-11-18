import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createBasicAuthenticator, createJwtAuthenticator, createServiceRuntime } from "../dist/core/index.js";

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
