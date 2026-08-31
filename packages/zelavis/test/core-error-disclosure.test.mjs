import assert from "node:assert/strict";
import test from "node:test";

import { createServiceRuntime, defineServerPlugin } from "../dist/core/index.js";

class DatabaseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseValidationError";
  }
}

class ZelavisProjectRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZelavisProjectRuntimeError";
  }
}

async function runtimeThrowing(error, hooks = {}) {
  return createServiceRuntime({
    prefix: "/api/v1",
    version: "v1",
    ...hooks,
    services: [
      {
        name: "boom",
        basePath: "/boom",
        service: {},
        api: {
          v1: [
            {
              id: "boom.get",
              method: "GET",
              path: "/",
              handler: () => {
                throw error;
              },
            },
          ],
        },
      },
    ],
  });
}

const call = (runtime) =>
  runtime.fetch(new Request("http://localhost/api/v1/boom"));

test("an unexpected error never returns its message", async () => {
  const secret =
    "ENOENT: no such file or directory, open '/Users/someone/.zelavis/system.db'";
  const runtime = await runtimeThrowing(new Error(secret));

  const response = await call(runtime);
  assert.equal(response.status, 500);

  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.ok(
    !serialized.includes("ENOENT"),
    `leaked the exception message: ${serialized}`,
  );
  assert.ok(!serialized.includes("/Users/someone"), "leaked a filesystem path");
  assert.equal(body.error, "The request could not be completed.");
  assert.match(
    body.correlationId,
    /^[0-9a-f]{16}$/,
    "a correlation id must be returned so logs can be joined",
  );
});

test("a typed domain error keeps its message", async () => {
  const runtime = await runtimeThrowing(
    new DatabaseValidationError("A Tenant ID is required."),
  );

  const body = await (await call(runtime)).json();
  assert.equal(body.error, "A Tenant ID is required.");
  assert.equal(body.correlationId, undefined);
});

test("an actionable Project runtime error keeps its safe message", async () => {
  const runtime = await runtimeThrowing(
    new ZelavisProjectRuntimeError("Native WordPress requires PHP-FPM."),
  );

  const body = await (await call(runtime)).json();
  assert.equal(body.error, "Native WordPress requires PHP-FPM.");
  assert.equal(body.correlationId, undefined);
});

test("the correlation id reaches the error lifecycle event", async () => {
  const seen = [];
  const plugin = defineServerPlugin(({ hooks }) => {
    hooks.hook("error", (event) => {
      seen.push({
        correlationId: event.correlationId,
        message: event.error?.message,
      });
    });
  });
  const runtime = await runtimeThrowing(new Error("internal detail"), {
    plugins: [plugin],
  });

  const body = await (await call(runtime)).json();

  assert.equal(seen.length, 1, "the error hook must observe the failure");
  assert.equal(
    seen[0].message,
    "internal detail",
    "the hook still receives the full cause",
  );
  assert.equal(
    seen[0].correlationId,
    body.correlationId,
    "the logged id must match the one the client received",
  );
});

test("correlation ids are unguessable and unique per failure", async () => {
  const runtime = await runtimeThrowing(new Error("internal detail"));
  const ids = new Set();
  for (let index = 0; index < 20; index += 1) {
    ids.add((await (await call(runtime)).json()).correlationId);
  }
  assert.equal(ids.size, 20, "each failure must get its own id");
});
