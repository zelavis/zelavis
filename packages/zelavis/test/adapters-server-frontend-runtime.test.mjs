import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerFrontendProjectRuntime } from "../dist/adapters/_server-frontend-project-runtime.js";

/** Writes a frontend package whose server binds whatever port it is given. */
async function writeFrontend(root, { name = "@acme/app", portEnv, server } = {}) {
  const directory = join(root, "frontend");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      zelavis: {
        kind: "frontend",
        frontend: {
          runtime: "server",
          start: ["node", "./server.mjs"],
          ...(portEnv ? { portEnv } : {}),
        },
      },
    }),
  );
  await writeFile(
    join(directory, "server.mjs"),
    server ??
      `import { createServer } from "node:http";
const port = Number(process.env.${portEnv ?? "PORT"});
createServer((_, res) => { res.end("frontend"); }).listen(port, "127.0.0.1");
`,
  );
  return directory;
}

const descriptor = { id: "site-frontend", name: "Frontend", kind: "zelavis", runtimeKind: "native" };
const app = { name: "@acme/app", title: "App", version: "1.0.0", specifier: "@acme/app", runtimeKinds: ["native"] };

async function runtimeFor(root, frontendDirectory, overrides = {}) {
  return createServerFrontendProjectRuntime({
    directory: join(root, "projects"),
    resolveFrontendDirectory: async () => frontendDirectory,
    startupTimeoutMs: 15_000,
    ...overrides,
  });
}

test("a server frontend starts, reports a routable URL, and serves", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const runtime = await runtimeFor(root, await writeFrontend(root));

  try {
    await runtime.prepare({ ...descriptor }, app);
    const snapshot = await runtime.start({ ...descriptor });

    assert.equal(snapshot.status, "running");
    assert.match(snapshot.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    // The URL must actually be routable — readiness is a port check, so a
    // snapshot that says running has to mean the frontend answers.
    const response = await fetch(snapshot.url);
    assert.equal(await response.text(), "frontend");

    assert.equal((await runtime.status("site-frontend")).status, "running");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a custom port environment variable is honoured", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const runtime = await runtimeFor(
    root,
    await writeFrontend(root, { portEnv: "APP_PORT" }),
  );

  try {
    await runtime.prepare({ ...descriptor }, app);
    const snapshot = await runtime.start({ ...descriptor });
    assert.equal(snapshot.status, "running");
    assert.equal((await (await fetch(snapshot.url)).text()), "frontend");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a frontend that exits before binding fails with its own output", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const runtime = await runtimeFor(
    root,
    await writeFrontend(root, {
      server: 'console.error("missing build output"); process.exit(1);\n',
    }),
  );

  try {
    await runtime.prepare({ ...descriptor }, app);
    await assert.rejects(
      () => runtime.start({ ...descriptor }),
      (error) => {
        assert.match(error.message, /exited before binding/);
        // The frontend's own stderr is what an operator needs to debug it.
        assert.match(error.message, /missing build output/);
        return true;
      },
    );
    assert.equal((await runtime.status("site-frontend")).status, "failed");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a frontend that never binds times out rather than hanging", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const runtime = await runtimeFor(
    root,
    await writeFrontend(root, { server: "setTimeout(() => {}, 60_000);\n" }),
    { startupTimeoutMs: 1_000 },
  );

  try {
    await runtime.prepare({ ...descriptor }, app);
    await assert.rejects(
      () => runtime.start({ ...descriptor }),
      /did not bind PORT=\d+ within 1000ms/,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-server frontend is refused at prepare", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const directory = join(root, "static");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@acme/static",
      version: "1.0.0",
      zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist" } },
    }),
  );
  const runtime = await runtimeFor(root, directory);

  try {
    await assert.rejects(
      () => runtime.prepare({ ...descriptor }, app),
      /is not a server frontend/,
      "a static frontend must never be given a process",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping and destroying a frontend releases its process", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  const runtime = await runtimeFor(root, await writeFrontend(root));

  try {
    await runtime.prepare({ ...descriptor }, app);
    const snapshot = await runtime.start({ ...descriptor });

    await runtime.stop("site-frontend");
    assert.equal((await runtime.status("site-frontend")).status, "stopped");
    await assert.rejects(() => fetch(snapshot.url), "the port must be released");

    await runtime.destroy("site-frontend");
    assert.equal((await runtime.status("site-frontend")).status, "stopped");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
