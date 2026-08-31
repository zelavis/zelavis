import assert from "node:assert/strict";
import test from "node:test";
// `projectProcessEnvironment` is exported from the Node project driver, so the
// regression imports it directly rather than scraping the built bundle.
import { projectProcessEnvironment } from "../dist/adapters/_node-project-runtime.js";

test("Project children do not inherit Platform secrets", () => {
  const planted = {
    ZELAVIS_BOOTSTRAP_TOKEN: "planted-bootstrap-token",
    STRIPE_SECRET_KEY: "planted-provider-credential",
    DATABASE_URL: "postgres://planted",
    AWS_SECRET_ACCESS_KEY: "planted-signing-key",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=planted",
  };
  const restore = {};
  for (const [name, value] of Object.entries(planted)) {
    restore[name] = process.env[name];
    process.env[name] = value;
  }

  try {
    const environment = projectProcessEnvironment();
    for (const name of Object.keys(planted)) {
      assert.equal(
        environment[name],
        undefined,
        `${name} must not reach a Project child process`,
      );
    }
    const serialized = JSON.stringify(environment);
    for (const value of Object.values(planted)) {
      assert.ok(
        !serialized.includes(value),
        `planted secret ${value} leaked into the child environment`,
      );
    }
  } finally {
    for (const [name, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Project children still inherit what a Node process needs to run", () => {
  const restorePath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const environment = projectProcessEnvironment();
    assert.equal(environment.PATH, "/usr/bin:/bin");
  } finally {
    process.env.PATH = restorePath;
  }
});
