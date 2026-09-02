import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineAdapter, Zelavis } from "../index.js";
import { closeNodeServer, createNodeServer } from "../runtimes/node.js";
import { toDefaultErrorResponse } from "../core/runtime/request-dispatcher.js";
import { nodeAdapter } from "./node.js";
import {
  createGatewayNonceTracker,
  verifyGatewayAuthority,
  ZELAVIS_GATEWAY_AUTHORITY_HEADER,
} from "../platform/gateway-authority.js";

const projectId = process.env.ZELAVIS_PROJECT_ID?.trim();
const dataDirectory = process.env.ZELAVIS_PROJECT_DATA_DIR?.trim();
const port = Number(process.env.PORT ?? 0);
/**
 * Secret shared with the Platform process that started this runtime. Without
 * it no Gateway authority is accepted at all, so an unauthenticated caller is
 * simply anonymous rather than privileged.
 */
const gatewaySecret = process.env.ZELAVIS_PROJECT_GATEWAY_SECRET?.trim();
const gatewayNonces = createGatewayNonceTracker();

if (!projectId || !dataDirectory) {
  throw new Error("Project runner requires a project id and data directory.");
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Project runner received an invalid port.");
}

const projectRecord = JSON.parse(
  await readFile(resolve("project.json"), "utf8"),
) as {
  recipe?: {
    name?: unknown;
    version?: unknown;
    specifier?: unknown;
  };
};
const recipe = projectRecord.recipe;
if (
  !recipe ||
  typeof recipe.name !== "string" ||
  typeof recipe.version !== "string" ||
  typeof recipe.specifier !== "string"
) {
  throw new Error("Project runner requires an exactly versioned Project recipe lock.");
}
const lockedRecipeName = recipe.name;
const lockedRecipeVersion = recipe.version;
const lockedRecipeSpecifier = recipe.specifier;

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
        resolvePrincipal: async ({ request }) => {
          // The runtime listens on loopback, so any local process can send
          // whatever headers it likes. Authority is only accepted as an
          // envelope signed with the secret this process was started with.
          if (!gatewaySecret) return undefined;

          const token = request.headers.get(
            ZELAVIS_GATEWAY_AUTHORITY_HEADER,
          );
          if (!token) return undefined;

          const claims = await verifyGatewayAuthority(gatewaySecret, token, {
            audienceProjectId: projectId,
            consumeNonce: gatewayNonces,
          });
          if (!claims) return undefined;

          return {
            id: claims.subject,
            type: claims.subjectType as "user" | "system" | "service",
            // The caller's own Project permissions, never a wildcard.
            grants: claims.permissions.map((permission) => ({
              permission,
              scope: { type: "project" as const, projectId },
            })),
            metadata: {
              projectId,
              placementGeneration: String(claims.generation),
              runtimeNodeId: claims.runtimeNodeId,
              platformScopeId: claims.scopeId,
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
                name: lockedRecipeName,
                version: lockedRecipeVersion,
                kind: "app",
                scope: "system",
                api: {},
                service: {},
              },
              specifier: lockedRecipeSpecifier,
              status: "installed",
              source: "official",
            },
          ],
        },
      };
    },
  }),
  // Without this the child answers every failure as a 400 carrying the raw
  // exception message, which bypasses the runtime's disclosure policy.
  onError: ({ error, correlationId }) =>
    toDefaultErrorResponse(error, correlationId),
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
