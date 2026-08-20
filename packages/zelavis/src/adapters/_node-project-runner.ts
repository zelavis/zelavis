import { resolve } from "node:path";
import { defineAdapter, Zelavis } from "../index.js";
import { createNodeServer } from "../node/index.js";
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

const projectNodeAdapter = nodeAdapter({
  dataDirectory: resolve(dataDirectory),
  blueprints: false,
  projects: false,
});
const zv = new Zelavis({
  adapter: defineAdapter({
    name: "node-project",
    async resolve(options) {
      const resolved = await projectNodeAdapter.resolve!(options);
      return {
        ...resolved,
        coreServices: {
          ...resolved.coreServices,
          dashboard: false,
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

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
