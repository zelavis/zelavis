import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineAdapter, Zelavis } from "../index.js";
import { closeNodeServer, createNodeServer } from "../runtimes/node.js";
import { nodeAdapter } from "./node.js";

const projectId = process.env.ZELAVIS_PROJECT_ID?.trim();
const dataDirectory = process.env.ZELAVIS_PROJECT_DATA_DIR?.trim();
const port = Number(process.env.PORT ?? 0);

if (!projectId || !dataDirectory) {
  throw new Error("Project runner requires a project id and data directory.");
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Project runner received an invalid port.");
}

const projectRecord = JSON.parse(
  await readFile(resolve("project.json"), "utf8"),
) as {
  app?: {
    name?: unknown;
    version?: unknown;
    specifier?: unknown;
  };
};
const app = projectRecord.app;
if (
  !app ||
  typeof app.name !== "string" ||
  typeof app.version !== "string" ||
  typeof app.specifier !== "string"
) {
  throw new Error("Project runner requires an exactly versioned app service lock.");
}
const lockedAppName = app.name;
const lockedAppVersion = app.version;
const lockedAppSpecifier = app.specifier;

const projectNodeAdapter = nodeAdapter({
  role: "project",
  dataDirectory: resolve(dataDirectory),
  projects: false,
});
const zv = new Zelavis({
  adapter: defineAdapter({
    name: "node-project",
    async resolve(options) {
      const resolved = await projectNodeAdapter.resolve?.(options);
      return {
        ...(resolved ?? {}),
        metadata: {
          ...(resolved?.metadata ?? {}),
          projectId,
        },
        resolvePrincipal: ({ request }) => {
          const forwardedProjectId = request.headers.get(
            "x-zelavis-project-id",
          );
          const scopeId = request.headers.get("x-zelavis-platform-scope-id");
          const generation = request.headers.get(
            "x-zelavis-placement-generation",
          );
          const runtimeNodeId = request.headers.get("x-zelavis-runtime-node-id");
          if (
            forwardedProjectId !== projectId ||
            !scopeId ||
            !generation ||
            !runtimeNodeId
          ) return undefined;
          return {
            id: `zelavis-platform:${scopeId}`,
            type: "system",
            permissions: ["*"],
            grants: [
              {
                permission: "*",
                scope: { type: "project", projectId },
              },
            ],
            metadata: {
              projectId,
              placementGeneration: generation,
              runtimeNodeId,
              authority: "project-gateway",
            },
          };
        },
        serviceRegistry: {
          ...(resolved?.serviceRegistry ?? {}),
          catalog: [
            ...(resolved?.serviceRegistry?.catalog ?? []),
            {
              service: {
                name: lockedAppName,
                version: lockedAppVersion,
                kind: "app",
                scope: "system",
                api: {},
                service: {},
              },
              specifier: lockedAppSpecifier,
              status: "installed",
              source: "official",
            },
          ],
        },
      };
    },
  }),
  onError: ({ error }) => ({
    status: 400,
    body: { error: error instanceof Error ? error.message : "Unknown error" },
  }),
});
const server = await createNodeServer(zv);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Project runner could not resolve its listening address.");
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      projectId,
      url: `http://127.0.0.1:${address.port}`,
    })}\n`,
  );
});

let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  shutdownPromise ??= Promise.all([
    closeNodeServer(server),
    zv.close(),
  ]).then(
    () => undefined,
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
