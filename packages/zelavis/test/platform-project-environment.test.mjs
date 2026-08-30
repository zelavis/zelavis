import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// `projectProcessEnvironment` is internal to the Node project driver, so the
// regression test exercises it directly out of the built bundle.
const source = readFileSync(
  new URL("../dist/adapters/_node-project-runtime.js", import.meta.url),
  "utf8",
);
const declaration = source.match(
  /const INHERITED_PROJECT_ENVIRONMENT[\s\S]*?function projectProcessEnvironment[\s\S]*?\n}\n/,
);
assert.ok(declaration, "projectProcessEnvironment must exist in the built driver");
const projectProcessEnvironment = new Function(
  `${declaration[0]}; return projectProcessEnvironment;`,
)();

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
