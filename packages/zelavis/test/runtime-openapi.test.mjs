import assert from "node:assert/strict";
import test from "node:test";
import emailPasswordProvider from "@zelavis/app-auth-email-password";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

async function spec(options = {}, path = "/zelavis/api/v1/runtime/openapi.json") {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    ...options,
  });
  const response = await runtime.fetch(new Request(`http://localhost${path}`));
  return { runtime, response, body: response.status === 200 ? await response.json() : undefined };
}

function operations(document) {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ path, method, operation })),
  );
}

test("the spec is served with and without the .json extension", async () => {
  // The extensionless path is what a reader tries first; answering it with a
  // 404 reads as "this Platform publishes no spec".
  for (const path of [
    "/zelavis/api/v1/runtime/openapi",
    "/zelavis/api/v1/runtime/openapi.json",
  ]) {
    const { response, body } = await spec({}, path);
    assert.equal(response.status, 200, path);
    assert.equal(body.openapi, "3.1.0");
  }
});

test("published paths are the paths this runtime actually serves", async () => {
  const { runtime, body } = await spec();

  // The generator used to re-resolve endpoints from the service list with a
  // different prefix and no service prefixes, publishing `/api/auth/accounts`
  // for an endpoint served at `/zelavis/api/v1/auth/accounts`. Every path in
  // the document must correspond to a mounted route.
  const mounted = new Set(
    runtime.routes.map((route) =>
      route.fullPath
        .replace(/:([a-zA-Z0-9_]+)/g, "{$1}")
        .replace(/\*([a-zA-Z0-9_]+)/g, "{$1}"),
    ),
  );
  for (const path of Object.keys(body.paths)) {
    assert.ok(mounted.has(path), `${path} is published but not mounted`);
  }
  assert.ok(Object.keys(body.paths).length > 20);
});

test("the whole control plane is described, not only the annotated part", async () => {
  const { body } = await spec();

  // Filtering to routes carrying a `spec` omitted most of the Platform's own
  // endpoints while the document still looked complete.
  const paths = Object.keys(body.paths);
  for (const expected of [
    "/zelavis/api/v1/runtime/config",
    "/zelavis/api/v1/runtime/services",
  ]) {
    assert.ok(paths.includes(expected), `${expected} is missing from the spec`);
  }
});

test("an endpoint nobody has documented says so rather than looking described", async () => {
  const { body } = await spec();
  const config = body.paths["/zelavis/api/v1/runtime/config"].get;

  assert.equal(config["x-zelavis-undocumented"], true);
  // A route id is stable and unique, so it stands in for an operation id
  // nobody has written yet.
  assert.equal(typeof config.operationId, "string");
  assert.ok(config.operationId.length > 0);
});

test("declared route metadata survives", async () => {
  const { body } = await spec({
    subsystems: {},
    bootstrap: { token: "openapi-bootstrap-token-with-32-characters" },
    serviceRegistry: {
      catalog: [{ service: emailPasswordProvider, status: "installed", source: "official" }],
    },
  });

  const bootstrap = body.paths["/zelavis/api/v1/auth/bootstrap"].post;
  assert.equal(bootstrap.operationId, "bootstrapPlatformOwner");
  assert.equal(bootstrap.summary, "Create the first Platform owner");
  assert.deepEqual(bootstrap.tags, ["auth"]);
  assert.equal(bootstrap["x-zelavis-undocumented"], undefined);
});

test("the document is well formed enough to generate a client from", async () => {
  const { body } = await spec();

  assert.deepEqual(body.servers, [{ url: "http://localhost" }]);

  const ids = [];
  for (const { path, method, operation } of operations(body)) {
    ids.push(operation.operationId);
    assert.ok(operation.responses, `${method} ${path} has no responses`);

    // Every templated segment needs a declared parameter, or the document is
    // invalid — this is where the router's `*rest` wildcards used to leak
    // through as literal asterisks.
    const declared = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
    const parameters = (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name);
    for (const name of declared) {
      assert.ok(parameters.includes(name), `${method} ${path} does not declare ${name}`);
    }
    assert.ok(!path.includes("*"), `${path} still carries router syntax`);
  }

  assert.equal(ids.length, new Set(ids).size, "operationIds must be unique");
});
