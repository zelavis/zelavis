/**
 * Starts a real server frontend, fetches it, and stops it.
 *
 * A standalone script rather than a test, because the frontend driver spawns a
 * child process whose piped stdio keeps `node --test` alive after the
 * assertions finish — the scenario passed but the runner never exited. Run as
 * its own process, the child tree dies with it and a hang becomes a timeout the
 * caller can report instead of a suite that never returns.
 *
 * Prints one JSON line so the caller asserts on observed behavior rather than
 * on this script's exit code.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "adapters",
  "_local-project-runtime.js",
);
const { createLocalProjectRuntime } = await import(dist);

/** A frontend that knows nothing about Zelavis beyond the port it is handed. */
const SERVER_JS = `
import { createServer } from "node:http";
createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("served by the frontend on " + process.env.PORT);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const result = { steps: [] };
const root = await mkdtemp(join(tmpdir(), "zelavis-live-frontend-"));
const packageDirectory = join(root, "package");
let runtime;

try {
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "server.js"), SERVER_JS);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@acme/theme",
      version: "1.0.0",
      type: "module",
      exports: { ".": { import: "./server.js" } },
      zelavis: {
        kind: "frontend",
        frontend: { runtime: "server", start: ["node", "server.js"] },
      },
    }),
  );

  runtime = createLocalProjectRuntime({
    directory: join(root, "projects"),
    serverFrontend: {
      resolveFrontendDirectory: async () => packageDirectory,
      startupTimeoutMs: 20_000,
    },
  });

  const project = {
    id: "shop-site",
    name: "Shop Site",
    kind: "frontend",
    ownerProjectId: "shop",
    runtimeKind: "native",
    recipe: {
      name: "@acme/theme",
      title: "Acme Theme",
      version: "1.0.0",
      specifier: join(packageDirectory, "server.js"),
      runtimeKinds: ["native"],
    },
  };

  await runtime.prepare(project, project.recipe);
  result.steps.push("prepared");

  const started = await runtime.start(project);
  result.startStatus = started.status;
  result.url = started.url;

  // "running" has to mean the process is answering, not merely spawned: the
  // Gateway routes a Project's public traffic here.
  const response = await fetch(started.url);
  result.httpStatus = response.status;
  result.body = await response.text();

  // Reported through the Project id, which is the path the local runtime routes
  // by reading the Project record back from disk.
  const stopped = await runtime.stop(project.id);
  result.stopStatus = stopped.status;

  const after = await runtime.status(project.id);
  result.statusAfterStop = after.status;

  result.reachableAfterStop = await fetch(started.url)
    .then(() => true)
    .catch(() => false);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  await runtime?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

console.log(`ZELAVIS_RESULT ${JSON.stringify(result)}`);
