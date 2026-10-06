import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { defineAdapter, Zelavis } from "../index.js";
import { toDefaultErrorResponse } from "../core/runtime/request-dispatcher.js";
import { evaluate, integration, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { nodeAdapter } from "./node.js";
import { loadRecipeArtifact } from "./_recipe-artifact.js";
import { createGatewayNonceTracker, verifyGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../platform/gateway-authority.js";
import type { NodeRuntimeEngine } from "./_node-runtime-worker.js";

export const prepare = Effect.fn("ProjectEngine.prepare")(function* (configuration: Readonly<Record<string, unknown>>): Effect.fn.Return<NodeRuntimeEngine, TaggedFailure> {
  const { projectId, dataDirectory, descriptor } = yield* evaluate(() => {
    if (typeof configuration.projectId !== "string" || typeof configuration.dataDirectory !== "string" || typeof configuration.descriptor !== "string") throw new Error("Project engine requires exact Project identity, data and descriptor.");
    return { projectId: configuration.projectId, dataDirectory: resolve(configuration.dataDirectory), descriptor: resolve(configuration.descriptor) };
  });
  const source = yield* integration(() => readFile(descriptor, "utf8"));
  const recipe = yield* evaluate(() => {
    const record = JSON.parse(source);
    if (record.id !== projectId || typeof record.recipe?.name !== "string" || typeof record.recipe?.version !== "string" || typeof record.recipe?.specifier !== "string" || typeof record.recipe?.artifact?.digest !== "string")
      throw new Error("Project engine requires an exactly versioned, frozen recipe for this Project.");
    return record.recipe as { name: string; version: string; specifier: string; artifact: { digest: string } };
  });
  const artifact = yield* integration(() => loadRecipeArtifact(typeof configuration.recipeDataDirectory === "string" ? resolve(configuration.recipeDataDirectory) : dataDirectory, { name: recipe.name, version: recipe.version, digest: recipe.artifact.digest }));
  const lockedRecipe = { ...artifact, specifier: recipe.specifier, status: "installed" as const, source: "official" as const };
  return {
    open: Effect.fn("ProjectEngine.open")(function* () {
      const gatewaySecret = process.env.ZELAVIS_PROJECT_GATEWAY_SECRET?.trim();
      const gatewayNonces = createGatewayNonceTracker();
      // Managed applications use the ordinary App composition in their bound
      // private data root. The host changes placement, not the available APIs.
      const adapter = nodeAdapter({ role: "project", dataDirectory, projects: false });
      const zv = new Zelavis({ adapter: defineAdapter({ name: "node-project",
        close: () => present(integration(() => adapter.close?.())),
        resolve: options => present(Effect.gen(function* () {
          const resolved = yield* integration(() => adapter.resolve?.(options));
          return { ...(resolved ?? {}), metadata: { ...resolved?.metadata, projectId },
            resolvePrincipal: ({ request }) => present(Effect.gen(function* () {
              if (!gatewaySecret) return undefined;
              const token = request.headers.get(ZELAVIS_GATEWAY_AUTHORITY_HEADER);
              if (!token) return undefined;
              const claims = yield* integration(() => verifyGatewayAuthority(gatewaySecret, token, { audienceProjectId: projectId, consumeNonce: gatewayNonces }));
              if (!claims) return undefined;
              return { id: claims.subject, type: claims.subjectType as "user" | "system" | "service", permissions: claims.permissions,
                grants: claims.permissions.map(permission => ({ permission, scope: { type: "project" as const, projectId } })),
                metadata: { projectId, tenantId: claims.tenantId, placementGeneration: String(claims.generation), runtimeNodeId: claims.runtimeNodeId,
                  platformScopeId: claims.scopeId, authority: "project-gateway" } };
            })),
            serviceRegistry: { ...resolved?.serviceRegistry, catalog: [...resolved?.serviceRegistry?.catalog ?? [], lockedRecipe] },
          };
        })),
      }), onError: ({ error, correlationId }) => toDefaultErrorResponse(error, correlationId) });
      const runtime = yield* integration(() => zv.runtime()).pipe(Effect.onError(() => integration(() => zv.close()).pipe(Effect.ignore)));
      return { runtime, qualify: Effect.void, close: () => integration(() => zv.close()) };
    }),
  };
});
