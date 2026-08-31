import assert from "node:assert/strict";
import test from "node:test";

import {
  loadService,
  readFrontendManifest,
  toServiceAppDefinition,
  ZelavisFrontendManifestError,
  validatePluginPackageManifest,
} from "../dist/index.js";

const base = (frontend) => ({
  name: "@acme/site",
  version: "1.0.0",
  type: "module",
  zelavis: { kind: "frontend", frontend },
});

test("a package that is not a frontend reads as undefined", () => {
  assert.equal(
    readFrontendManifest({ name: "@acme/plugin", zelavis: { kind: "plugin" } }),
    undefined,
  );
  assert.equal(readFrontendManifest({ name: "@acme/plain" }), undefined);
});

test("a static frontend declares its bundle and mode", () => {
  const frontend = readFrontendManifest(
    base({ runtime: "static", bundle: "dist", mode: "mpa", indexHtml: "home.html" }),
  );

  assert.deepEqual(frontend, {
    runtime: "static",
    bundle: "dist",
    mode: "mpa",
    indexHtml: "home.html",
  });
});

test("the runtime is declared, never inferred from a start script", () => {
  // A `start` script says nothing about whether a process should be spawned —
  // plenty of static builds have one — so its presence must not decide.
  assert.throws(
    () =>
      readFrontendManifest({
        name: "@acme/site",
        scripts: { start: "node server.js" },
        zelavis: { kind: "frontend", frontend: { bundle: "dist" } },
      }),
    (error) => {
      assert.ok(error instanceof ZelavisFrontendManifestError);
      assert.match(error.message, /must be "static" or "server"/);
      return true;
    },
  );
});

test("a static frontend must declare a bundle", () => {
  assert.throws(
    () => readFrontendManifest(base({ runtime: "static" })),
    /must declare "frontend.bundle"/,
  );
});

test("a bundle path cannot escape the package", () => {
  for (const bundle of ["../secrets", "/etc", "dist/../../out", ".."]) {
    assert.throws(
      () => readFrontendManifest(base({ runtime: "static", bundle })),
      /must stay inside the package/,
      `${bundle} must be refused`,
    );
  }
});

test("a server frontend declares its start command as argv", () => {
  const frontend = readFrontendManifest(
    base({ runtime: "server", start: ["node", "./server.js"], portEnv: "APP_PORT" }),
  );
  assert.deepEqual(frontend, {
    runtime: "server",
    start: ["node", "./server.js"],
    portEnv: "APP_PORT",
  });
});

test("a server frontend cannot smuggle a shell string", () => {
  // argv, not a shell line: a string would need quoting rules and would let a
  // manifest put shell metacharacters into process spawning.
  assert.throws(
    () => readFrontendManifest(base({ runtime: "server", start: "node server.js; rm -rf /" })),
    /non-empty array of command arguments/,
  );
  assert.throws(
    () => readFrontendManifest(base({ runtime: "server", start: [] })),
    /non-empty array/,
  );
});

test("a port environment variable must be a valid name", () => {
  assert.throws(
    () =>
      readFrontendManifest(
        base({ runtime: "server", start: ["node", "s.js"], portEnv: "not a name" }),
      ),
    /valid environment variable name/,
  );
});

test("a static frontend projects onto the service app definition", () => {
  const frontend = readFrontendManifest(base({ runtime: "static", bundle: "build" }));
  assert.deepEqual(toServiceAppDefinition(frontend), {
    mount: "/",
    bundle: "build",
    mode: "spa",
  });

  const mounted = toServiceAppDefinition(frontend, { mount: "/docs" });
  assert.equal(mounted.mount, "/docs");
});

test("a malformed frontend is refused at manifest validation", () => {
  // Caught at install rather than surfacing as a broken site on first visit.
  assert.throws(
    () => validatePluginPackageManifest(base({ runtime: "static" })),
    /must declare "frontend.bundle"/,
  );
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@acme/site",
        zelavis: { kind: "frontend" },
      }),
    /must declare a "zelavis.frontend" object/,
  );
});

test("a static frontend package loads as an app-serving service", async () => {
  // A static frontend is files, not code: it must load without a JS entry.
  const service = await loadService("@acme/site", {
    manifest: {
      name: "@acme/site",
      version: "1.0.0",
      type: "module",
      zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist" } },
    },
    importer: async () => ({}),
  });

  assert.equal(service.name, "@acme/site");
  assert.equal(service.kind, "frontend");
  // It reuses the existing app-serving machinery rather than a second file server.
  assert.deepEqual(service.app, { mount: "/", bundle: "dist", mode: "spa" });
});

test("a server frontend is refused with a message that says why", async () => {
  await assert.rejects(
    () =>
      loadService("@acme/app", {
        manifest: {
          name: "@acme/app",
          version: "1.0.0",
          type: "module",
          zelavis: {
            kind: "frontend",
            frontend: { runtime: "server", start: ["node", "./server.js"] },
          },
        },
        importer: async () => ({}),
      }),
    (error) => {
      assert.match(error.message, /not executable yet/);
      assert.match(error.message, /supervised process/);
      return true;
    },
    "installing something that silently serves nothing would be worse than refusing",
  );
});
