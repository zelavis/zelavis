import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { defineAdapter, Zelavis } from "../index.js";
import { toDefaultErrorResponse } from "../core/runtime/request-dispatcher.js";
import { describeFailure, evaluate, integration, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { nodeAdapter } from "./node.js";
import { loadRecipeArtifact } from "./_recipe-artifact.js";
import { stageRecipeBackup } from "./_recipe-project-runtime.js";
import { InvalidBackup } from "../db/errors.js";
import { createGatewayNonceTracker, verifyGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../platform/gateway-authority.js";
import { httpLeaseStore } from "../db/writer-lease-http.js";
import type { NodeDatabaseLease } from "../db/node-host.js";
import { remoteDatabaseLeader } from "../db/leader.js";
import { createZelavisClient } from "../sdk/fetch.js";
import type { NodeRuntimeEngine } from "./_node-runtime-worker.js";
import type { ZelavisServerRuntime } from "../core/runtime/contracts.js";

/**
 * The Project's writer lease, when its start is guarded by one: the lease authority (the Platform), a token with
 * `database.replicate` at the system scope, this node's id, and the standby this node's writes wait for. All or nothing:
 * a lease authority without the rest is a misconfigured start, refused rather than run unguarded.
 */
export const leaseFromEnvironment = (projectId: string, environment: Readonly<Record<string, string | undefined>> = process.env): NodeDatabaseLease | undefined => {
  const authority = environment.ZELAVIS_LEASE_AUTHORITY?.trim();
  if (!authority) return undefined;
  const token = environment.ZELAVIS_LEASE_TOKEN?.trim();
  const owner = environment.ZELAVIS_LEASE_NODE?.trim();
  const standby = environment.ZELAVIS_LEASE_STANDBY?.trim();
  if (!token || !owner || !standby) {
    throw new Error("A lease-guarded Project start needs ZELAVIS_LEASE_TOKEN, ZELAVIS_LEASE_NODE and ZELAVIS_LEASE_STANDBY beside ZELAVIS_LEASE_AUTHORITY.");
  }
  const ttl = Number(environment.ZELAVIS_LEASE_TTL_MILLIS);
  if (!Number.isSafeInteger(ttl) || ttl < 1000) {
    throw new Error("A lease-guarded Project start needs ZELAVIS_LEASE_TTL_MILLIS, an integer of at least 1000, beside ZELAVIS_LEASE_AUTHORITY.");
  }
  const role = environment.ZELAVIS_LEASE_ROLE?.trim();
  if (role !== "writer" && role !== "standby") {
    throw new Error("A lease-guarded Project start needs ZELAVIS_LEASE_ROLE, writer or standby, beside ZELAVIS_LEASE_AUTHORITY.");
  }
  const endpoint = environment.ZELAVIS_LEASE_ENDPOINT?.trim();
  const leases = httpLeaseStore({ apiRoot: authority, token, route: "project-leases" });
  if (role === "standby") {
    // The standby reads its writer through the Platform, with the token it was started with, which holds only
    // `database.replicate` on this Project. The Platform routes to wherever the Project is placed, so the one endpoint
    // every lease names is right at every epoch.
    const platform = endpoint ? new URL(endpoint) : undefined;
    if (platform === undefined) throw new Error("A standby Project start needs ZELAVIS_LEASE_ENDPOINT, the Platform it follows its writer through.");
    const rootPath = platform.pathname.replace(/\/+$/, "") || "/";
    return {
      role, leases, scope: projectId, owner, successor: standby, ttlMillis: ttl, endpoint,
      // Once promoted it is the writer, and a writer that finds itself superseded stops serving (see below).
      onSuperseded: () => {
        console.error(`Project ${projectId} was superseded as the writer of its database; stopping.`);
        process.exit(75);
      },
      leaderFor: () => remoteDatabaseLeader(createZelavisClient({
        baseUrl: platform.origin, rootPath, headers: { authorization: `Bearer ${token}` },
      }).followers(projectId)),
    };
  }
  return {
    role, leases,
    scope: projectId, owner, standby, ttlMillis: ttl,
    ...(endpoint ? { endpoint } : {}),
    // A writer that finds itself superseded stops serving instead of only being refused: its reads would be stale.
    onSuperseded: () => {
      console.error(`Project ${projectId} was superseded as the writer of its database; stopping.`);
      process.exit(75);
    },
  };
};

/**
 * The Project channel to the Platform's shard routes, when this process was started with one: both variables or
 * neither, as a half-configured channel could only fail later and further from its cause.
 */
export const appShardsFromEnvironment = (projectId: string, environment: Readonly<Record<string, string | undefined>> = process.env): { readonly apiRoot: string; readonly token: string; readonly projectId: string } | undefined => {
  const apiRoot = environment.ZELAVIS_APP_SHARDS_AUTHORITY?.trim();
  const token = environment.ZELAVIS_APP_SHARDS_TOKEN?.trim();
  if (!apiRoot && !token) return undefined;
  if (!apiRoot || !token) throw new Error("A Project start needs ZELAVIS_APP_SHARDS_AUTHORITY and ZELAVIS_APP_SHARDS_TOKEN together.");
  return { apiRoot, token, projectId };
};

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
      // A managed app's integration runtime backs up the app's own data too: its files and, through the recipe's
      // own backup phase, its database. Its data root is `.zelavis/integration` inside the Project.
      const projectDirectory = resolve(dataDirectory, "..", "..");
      // A standby waits inside its database's open for the lease to lapse; closing this engine ends that wait.
      const standingBy = new AbortController();
      const found = leaseFromEnvironment(projectId);
      const lease = found?.role === "standby" ? { ...found, signal: standingBy.signal } : found;
      // The integration host serves the app's own APIs and never places shards.
      const appShards = configuration.integrationOnly === true ? undefined : appShardsFromEnvironment(projectId);
      const adapter = nodeAdapter({ role: "project", dataDirectory, projects: false,
        ...(lease === undefined && appShards === undefined ? {} : { database: { ...(lease === undefined ? {} : { lease }), ...(appShards === undefined ? {} : { appShards }) } }),
        ...(configuration.integrationOnly === true ? { backupComponents: [{
          name: "app",
          stage: (into: string) => stageRecipeBackup({ projectDirectory, into }).pipe(
            Effect.asVoid, Effect.mapError((error) => new InvalidBackup({ reason: `The app's own data could not be backed up: ${error.message}` }))),
        }] } : {}) });
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
      if (lease?.role === "standby") {
        // Nothing but the database opens before this standby holds the lease: Identity, Workloads and entities write to
        // the database at start, which would make a copy diverge. So the composition runs in the background (it waits
        // inside the database's standby open, following the writer), the engine is ready at once, and it answers 503
        // until the composition has finished.
        const composing = yield* Scope.make();
        let composed: Awaited<ReturnType<typeof zv.runtime>> | undefined;
        let failure: string | undefined;
        yield* Effect.forkIn(integration(() => zv.runtime(), { interruptible: true }).pipe(
          Effect.tap((runtime) => Effect.sync(() => { composed = runtime; })),
          Effect.tapError((error) => Effect.sync(() => {
            failure = describeFailure(error);
            console.error(`Project ${projectId} could not take over as the writer of its database: ${failure}`);
            process.exit(1);
          })),
        ), composing);
        const standing = () => Response.json({ error: failure === undefined ? "This Project is standing by for its writer." : failure }, { status: 503, headers: { "cache-control": "no-store" } });
        return {
          runtime: { fetch: (...args: Parameters<ZelavisServerRuntime["fetch"]>) => composed === undefined ? Promise.resolve(standing()) : composed.fetch(...args) },
          qualify: Effect.void,
          close: () => Effect.andThen(Effect.sync(() => standingBy.abort()), Effect.andThen(Scope.close(composing, Exit.void), integration(() => zv.close()))),
        };
      }
      const runtime = yield* integration(() => zv.runtime()).pipe(Effect.onError(() => integration(() => zv.close()).pipe(Effect.ignore)));
      return { runtime, qualify: Effect.void, close: () => integration(() => zv.close()) };
    }),
  };
});
