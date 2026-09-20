/**
 * Traefik dynamic configuration compiler for Zelavis Edge.
 *
 * Compiles an immutable {@link ZelavisEdgeCompiledPublication} into Traefik v3
 * dynamic configuration for the file provider. The compiler is pure and
 * deterministic: identical publication input produces identical configuration
 * files and hashes.
 *
 * The compiled output is written into a generation directory that Traefik watches
 * via its file provider (`providers.file.directory`).
 *
 * @module zelavis/edge/traefik-compiler
 */

import { createHash } from "node:crypto";
import {
  ZelavisEdgeValidationError,
  type ZelavisEdgeCapability,
} from "./index.js";
import type {
  ZelavisEdgeCompiledPublication,
  ZelavisEdgeHostname,
  ZelavisEdgeRoute,
} from "./routes.js";

// ---------------------------------------------------------------------------
// Supported capabilities
// ---------------------------------------------------------------------------

/**
 * Capabilities supported by the Traefik Edge adapter. Any publication requiring
 * capabilities outside this set will be rejected during compilation.
 */
export const TRAEFIK_SUPPORTED_CAPABILITIES: readonly ZelavisEdgeCapability[] = [
  "http",
  "https",
  "websocket",
  "sse",
  "weighted-targets",
  "active-health-checks",
  "connection-draining",
  "certificate-hot-reload",
];

// ---------------------------------------------------------------------------
// Compiler options and result types
// ---------------------------------------------------------------------------

export interface CompileTraefikOptions {
  /**
   * Generation identifier (e.g. "rev-1"). Defaults to "rev-${publication.revision}".
   */
  generation?: string;
  /**
   * Directory where certificate files are staged on disk.
   * Defaults to "/var/lib/zelavis/edge/traefik/certs".
   */
  certificateDirectory?: string;
  /**
   * Traefik entry points configuration.
   * Defaults to `{ http: "web", https: "websecure" }`.
   */
  entryPoints?: {
    http?: string;
    https?: string;
  };
  /**
   * Whether to redirect HTTP requests to HTTPS for hostnames configured with TLS.
   * Defaults to true.
   */
  redirectHttpToHttps?: boolean;
}

export interface TraefikRouterConfig {
  entryPoints: string[];
  rule: string;
  service: string;
  priority?: number;
  middlewares?: string[];
  tls?: Record<string, never>;
}

export interface TraefikServiceServer {
  url: string;
  weight?: number;
}

export interface TraefikServiceConfig {
  loadBalancer: {
    servers: TraefikServiceServer[];
    healthCheck?: {
      path: string;
      interval: string;
      timeout: string;
    };
  };
}

export interface TraefikMiddlewareConfig {
  redirectScheme?: {
    scheme: string;
    permanent: boolean;
  };
  buffering?: {
    maxRequestBodyBytes?: number;
  };
}

export interface TraefikTlsCertificate {
  certFile: string;
  keyFile: string;
}

export interface TraefikDynamicConfiguration {
  http: {
    routers: Record<string, TraefikRouterConfig>;
    services: Record<string, TraefikServiceConfig>;
    middlewares?: Record<string, TraefikMiddlewareConfig>;
  };
  tls?: {
    certificates?: TraefikTlsCertificate[];
  };
}

export interface TraefikGenerationManifest {
  schemaVersion: 1;
  generation: string;
  revision: number;
  compiledAt: string;
  routerCount: number;
  serviceCount: number;
  certificateCount: number;
  contentHash: string;
}

export interface TraefikCompiledGeneration {
  generation: string;
  revision: number;
  files: Record<string, string>;
  manifest: TraefikGenerationManifest;
  configuration: TraefikDynamicConfiguration;
  requiredCapabilities: readonly ZelavisEdgeCapability[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeIdentifier(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildTraefikRule(route: ZelavisEdgeRoute): string {
  const hostRule = `Host(\`${route.hostname}\`)`;
  if (route.pathPrefix === "/") {
    return hostRule;
  }
  if (route.pathMatch === "exact") {
    return `${hostRule} && Path(\`${route.pathPrefix}\`)`;
  }
  return `${hostRule} && PathPrefix(\`${route.pathPrefix}\`)`;
}

function sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted = {} as T;
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    (sorted as Record<string, unknown>)[key] = obj[key];
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Compiler implementation
// ---------------------------------------------------------------------------

/**
 * Compile a canonical route publication into Traefik v3 dynamic configuration.
 *
 * @throws {ZelavisEdgeValidationError} if the publication requires capabilities
 *   that Traefik cannot satisfy.
 */
export function compileTraefikPublication(
  publication: ZelavisEdgeCompiledPublication,
  options: CompileTraefikOptions = {},
): TraefikCompiledGeneration {
  // Validate capabilities
  const supported = new Set(TRAEFIK_SUPPORTED_CAPABILITIES);
  for (const cap of publication.requiredCapabilities) {
    if (!supported.has(cap)) {
      throw new ZelavisEdgeValidationError(
        `Traefik edge adapter cannot satisfy required capability "${cap}".`,
      );
    }
  }

  const generation = options.generation ?? `rev-${publication.revision}`;
  const certDir = (options.certificateDirectory ?? "/var/lib/zelavis/edge/traefik/certs").replace(/\/+$/, "");
  const httpEntryPoint = options.entryPoints?.http ?? "web";
  const httpsEntryPoint = options.entryPoints?.https ?? "websecure";
  const redirectHttpToHttps = options.redirectHttpToHttps !== false;

  const hostnamesByHost = new Map<string, ZelavisEdgeHostname>();
  for (const hostname of publication.hostnames) {
    hostnamesByHost.set(hostname.host, hostname);
  }

  const routers: Record<string, TraefikRouterConfig> = {};
  const services: Record<string, TraefikServiceConfig> = {};
  const middlewares: Record<string, TraefikMiddlewareConfig> = {};

  let needsRedirectMiddleware = false;

  for (const route of publication.routes) {
    const safeId = sanitizeIdentifier(route.id);
    const serviceName = `svc_${route.scope}_${safeId}`;
    const rule = buildTraefikRule(route);

    // Build service definition
    const servers: TraefikServiceServer[] = route.targets.map((target) => ({
      url: target.url,
      ...(route.targets.length > 1 ? { weight: target.weight } : {}),
    }));

    services[serviceName] = {
      loadBalancer: {
        servers,
        ...(route.healthCheck
          ? {
              healthCheck: {
                path: route.healthCheck.path,
                interval: `${route.healthCheck.intervalMs}ms`,
                timeout: `${route.healthCheck.timeoutMs}ms`,
              },
            }
          : {}),
      },
    };

    // Route-specific middlewares (e.g. body buffering)
    const routeMiddlewares: string[] = [];
    if (route.maxRequestBodyBytes !== undefined) {
      const bufferMiddlewareName = `middleware_buffer_${safeId}`;
      middlewares[bufferMiddlewareName] = {
        buffering: {
          maxRequestBodyBytes: route.maxRequestBodyBytes,
        },
      };
      routeMiddlewares.push(bufferMiddlewareName);
    }

    const hostnameConfig = hostnamesByHost.get(route.hostname);
    const isAcmeChallenge = route.pathPrefix.startsWith("/.well-known/acme-challenge");
    const hasTls = !isAcmeChallenge && (hostnameConfig?.tlsMode === "managed" || hostnameConfig?.tlsMode === "external");

    if (hasTls) {
      // Secure router on https entryPoint
      const httpsRouterName = `router_${route.scope}_${safeId}_https`;
      routers[httpsRouterName] = {
        entryPoints: [httpsEntryPoint],
        rule,
        service: serviceName,
        tls: {},
        ...(route.priority !== 0 ? { priority: route.priority } : {}),
        ...(routeMiddlewares.length > 0 ? { middlewares: routeMiddlewares } : {}),
      };

      // HTTP redirect router
      if (redirectHttpToHttps) {
        needsRedirectMiddleware = true;
        const redirectRouterName = `router_${route.scope}_${safeId}_redirect`;
        routers[redirectRouterName] = {
          entryPoints: [httpEntryPoint],
          rule,
          service: serviceName,
          middlewares: ["middleware_redirect_https"],
          ...(route.priority !== 0 ? { priority: route.priority } : {}),
        };
      }
    } else {
      // Plain HTTP router on http entryPoint
      const httpRouterName = `router_${route.scope}_${safeId}_http`;
      routers[httpRouterName] = {
        entryPoints: [httpEntryPoint],
        rule,
        service: serviceName,
        ...(route.priority !== 0 ? { priority: route.priority } : {}),
        ...(routeMiddlewares.length > 0 ? { middlewares: routeMiddlewares } : {}),
      };
    }
  }

  if (needsRedirectMiddleware) {
    middlewares.middleware_redirect_https = {
      redirectScheme: {
        scheme: "https",
        permanent: true,
      },
    };
  }

  // Build TLS certificates list
  const certificates: TraefikTlsCertificate[] = [];
  for (const ref of publication.certificateRefs) {
    const safeRef = sanitizeIdentifier(ref);
    certificates.push({
      certFile: `${certDir}/${safeRef}.crt`,
      keyFile: `${certDir}/${safeRef}.key`,
    });
  }
  certificates.sort((a, b) => a.certFile.localeCompare(b.certFile));

  // Assemble dynamic configuration with deterministic key order
  const config: TraefikDynamicConfiguration = {
    http: {
      routers: sortObjectKeys(routers),
      services: sortObjectKeys(services),
      ...(Object.keys(middlewares).length > 0
        ? { middlewares: sortObjectKeys(middlewares) }
        : {}),
    },
    ...(certificates.length > 0
      ? { tls: { certificates } }
      : {}),
  };

  const dynamicJson = JSON.stringify(config, null, 2) + "\n";
  const contentHash = createHash("sha256").update(dynamicJson).digest("hex");

  const manifest: TraefikGenerationManifest = {
    schemaVersion: 1,
    generation,
    revision: publication.revision,
    compiledAt: publication.compiledAt,
    routerCount: Object.keys(routers).length,
    serviceCount: Object.keys(services).length,
    certificateCount: certificates.length,
    contentHash,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";

  return {
    generation,
    revision: publication.revision,
    files: {
      "traefik-dynamic.json": dynamicJson,
      "manifest.json": manifestJson,
    },
    manifest,
    configuration: config,
    requiredCapabilities: publication.requiredCapabilities,
  };
}

/**
 * Write a compiled Traefik generation to a target directory on disk.
 */
export async function writeTraefikGeneration(
  generation: TraefikCompiledGeneration,
  targetDirectory: string,
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  await mkdir(targetDirectory, { recursive: true });
  for (const [filename, content] of Object.entries(generation.files)) {
    const filePath = join(targetDirectory, filename);
    await writeFile(filePath, content, "utf8");
  }
}
