/**
 * Canonical Edge route publication store.
 *
 * This module defines the proxy-neutral route model that the Platform uses
 * to express ingress traffic intent. Reverse-proxy adapters (Traefik, Caddy,
 * Nginx) compile these canonical routes into their own configuration format;
 * the routes themselves never contain proxy-native syntax.
 *
 * The store is backed by {@link ZelavisSystemStore} using three namespaces:
 * - `edge.hostnames` — hostname TLS configuration
 * - `edge.routes` — canonical route definitions
 * - `edge.publications` — immutable compiled publication snapshots
 *
 * All mutations are CAS-safe: concurrent writes to the same hostname or
 * route id are resolved through compare-and-set without external locking.
 *
 * @module zelavis/edge/routes
 */

import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "../system-store.js";
import { ZelavisEdgeValidationError } from "./index.js";
import type { ZelavisEdgeCapability, ZelavisEdgePublication } from "./index.js";

// ---------------------------------------------------------------------------
// System Store namespaces
// ---------------------------------------------------------------------------

const HOSTNAMES_NAMESPACE = "edge.hostnames";
const ROUTES_NAMESPACE = "edge.routes";
const PUBLICATIONS_NAMESPACE = "edge.publications";
const CURRENT_PUBLICATION_KEY = "current";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ZelavisEdgeTlsMode = "managed" | "external" | "none";

/**
 * TLS and scope configuration for a hostname served through Zelavis Edge.
 *
 * Each hostname maps to exactly one scope (platform or project). TLS mode
 * determines whether Edge manages certificates automatically, expects an
 * external terminator, or serves plain HTTP.
 */
export interface ZelavisEdgeHostname {
  /** Lowercase FQDN. Unique across the store. */
  host: string;
  scope: "platform" | "project";
  /** Required when scope is `"project"`. */
  projectId?: string;
  tlsMode: ZelavisEdgeTlsMode;
  /** Opaque reference. Required when tlsMode is `"managed"`. */
  certificateRef?: string;
  createdAt: string;
  updatedAt: string;
}

export type ZelavisEdgeRouteProtocol = "http" | "websocket" | "sse" | "grpc";

/**
 * A backend target for an Edge route.
 *
 * Targets are proxy-neutral: the URL is the same loopback address that the
 * Project Gateway already uses. Placement generation and node id allow Fabric
 * fencing — an adapter can refuse to route to a stale target.
 */
export interface ZelavisEdgeRouteTarget {
  url: string;
  /** Weight for weighted load balancing, 1–100. */
  weight: number;
  /** Fabric placement generation. Adapters may refuse stale generations. */
  placementGeneration?: number;
  /** Fabric node id. Informational for multi-node topologies. */
  nodeId?: string;
}

/**
 * Active health check policy for a route's targets.
 */
export interface ZelavisEdgeHealthCheckPolicy {
  path: string;
  intervalMs: number;
  timeoutMs: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
}

/**
 * A canonical Edge route definition.
 *
 * Routes express proxy-neutral traffic intent: a hostname + path match
 * pattern routes to a set of weighted targets with protocol requirements,
 * traffic policy, and optional health checks. No Traefik middleware,
 * Caddy directives, or Nginx location blocks.
 */
export interface ZelavisEdgeRoute {
  /**
   * Unique route identifier. Convention:
   * - Platform: `platform:<name>` (e.g., `platform:dashboard`)
   * - Project: `project:<projectId>:<hostname>`
   */
  id: string;
  scope: "platform" | "project";
  /** Required when scope is `"project"`. */
  projectId?: string;
  /** FQDN this route matches. Must exist in the hostname store. */
  hostname: string;
  /** Path prefix to match. `"/"` matches all paths. */
  pathPrefix: string;
  pathMatch: "prefix" | "exact";
  targets: readonly ZelavisEdgeRouteTarget[];
  /** Protocol capabilities this route requires from the adapter. */
  protocols: readonly ZelavisEdgeRouteProtocol[];
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum request body size in bytes. */
  maxRequestBodyBytes?: number;
  healthCheck?: ZelavisEdgeHealthCheckPolicy;
  /** Higher priority wins on overlapping matches. Default 0. */
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * An immutable, self-contained snapshot of all routes and hostnames at a
 * point in time. Once compiled, a publication never changes. Adapters
 * compile this into their own proxy configuration format.
 */
export interface ZelavisEdgeCompiledPublication {
  schemaVersion: 1;
  /** Monotonic integer revision, advanced on each compilation. */
  revision: number;
  compiledAt: string;
  hostnames: readonly ZelavisEdgeHostname[];
  routes: readonly ZelavisEdgeRoute[];
  /** Capabilities derived from route protocols and hostname TLS modes. */
  requiredCapabilities: readonly ZelavisEdgeCapability[];
  /** Certificate references collected from all managed hostnames. */
  certificateRefs: readonly string[];
  routeCount: number;
}

/**
 * Canonical route publication store.
 *
 * The store manages hostnames, routes, and compiled publications backed by
 * the Platform System Store. All mutations are CAS-safe.
 */
export interface ZelavisEdgeRouteStore {
  // -- Hostname operations --------------------------------------------------

  putHostname(hostname: ZelavisEdgeHostname): Promise<ZelavisEdgeHostname>;
  getHostname(host: string): Promise<ZelavisEdgeHostname | undefined>;
  deleteHostname(host: string): Promise<boolean>;
  listHostnames(
    filter?: { scope?: "platform" | "project"; projectId?: string },
  ): Promise<readonly ZelavisEdgeHostname[]>;

  // -- Route operations -----------------------------------------------------

  putRoute(route: ZelavisEdgeRoute): Promise<ZelavisEdgeRoute>;
  getRoute(id: string): Promise<ZelavisEdgeRoute | undefined>;
  deleteRoute(id: string): Promise<boolean>;
  listRoutes(
    filter?: {
      scope?: "platform" | "project";
      projectId?: string;
      hostname?: string;
    },
  ): Promise<readonly ZelavisEdgeRoute[]>;
  /** Remove all routes and hostnames scoped to a project. */
  deleteProjectRoutes(projectId: string): Promise<number>;

  // -- Publication operations -----------------------------------------------

  /** Compile current routes and hostnames into an immutable publication. */
  compile(): Promise<ZelavisEdgeCompiledPublication>;
  getPublication(
    revision: number,
  ): Promise<ZelavisEdgeCompiledPublication | undefined>;
  getCurrentPublication(): Promise<ZelavisEdgeCompiledPublication | undefined>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const ROUTE_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9.:_-]{0,126}[a-z0-9])?$/;

const VALID_TLS_MODES: readonly ZelavisEdgeTlsMode[] = [
  "managed",
  "external",
  "none",
];
const VALID_PROTOCOLS: readonly ZelavisEdgeRouteProtocol[] = [
  "http",
  "websocket",
  "sse",
  "grpc",
];
const VALID_PATH_MATCHES = ["prefix", "exact"] as const;
const VALID_SCOPES = ["platform", "project"] as const;

function normalizeHostValue(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized || normalized.length > 253 || !HOSTNAME_PATTERN.test(normalized)) {
    throw new ZelavisEdgeValidationError(
      `"${host}" is not a valid hostname. Must be a lowercase FQDN with labels of 1-63 alphanumeric/hyphen characters.`,
    );
  }
  return normalized;
}

function normalizeRouteId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!normalized || !ROUTE_ID_PATTERN.test(normalized)) {
    throw new ZelavisEdgeValidationError(
      `Route id "${id}" must contain 1-128 lowercase letters, numbers, dots, colons, underscores, or hyphens.`,
    );
  }
  return normalized;
}

function validateScope(
  scope: string,
  projectId: string | undefined,
  label: string,
): asserts scope is "platform" | "project" {
  if (!VALID_SCOPES.includes(scope as "platform" | "project")) {
    throw new ZelavisEdgeValidationError(
      `${label} scope must be "platform" or "project".`,
    );
  }
  if (scope === "project" && (!projectId || !projectId.trim())) {
    throw new ZelavisEdgeValidationError(
      `${label} with scope "project" requires a non-empty projectId.`,
    );
  }
}

function validateHostname(hostname: ZelavisEdgeHostname): ZelavisEdgeHostname {
  const host = normalizeHostValue(hostname.host);
  validateScope(hostname.scope, hostname.projectId, "Hostname");
  if (!VALID_TLS_MODES.includes(hostname.tlsMode)) {
    throw new ZelavisEdgeValidationError(
      `Hostname tlsMode must be "managed", "external", or "none".`,
    );
  }
  if (hostname.tlsMode === "managed" && !hostname.certificateRef?.trim()) {
    throw new ZelavisEdgeValidationError(
      `Hostname with tlsMode "managed" requires a certificateRef.`,
    );
  }
  if (hostname.tlsMode === "none" && hostname.certificateRef) {
    throw new ZelavisEdgeValidationError(
      `Hostname with tlsMode "none" must not have a certificateRef.`,
    );
  }
  const certificateRef = hostname.certificateRef?.trim();
  if (certificateRef && certificateRef.length > 512) {
    throw new ZelavisEdgeValidationError(
      "Hostname certificateRef must not exceed 512 characters.",
    );
  }
  return {
    host,
    scope: hostname.scope,
    ...(hostname.projectId ? { projectId: hostname.projectId.trim() } : {}),
    tlsMode: hostname.tlsMode,
    ...(certificateRef ? { certificateRef } : {}),
    createdAt: hostname.createdAt,
    updatedAt: hostname.updatedAt,
  };
}

function validateTarget(target: ZelavisEdgeRouteTarget, index: number): ZelavisEdgeRouteTarget {
  const url = target.url?.trim();
  if (!url) {
    throw new ZelavisEdgeValidationError(
      `Target ${index} requires a non-empty url.`,
    );
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocol");
    }
  } catch {
    throw new ZelavisEdgeValidationError(
      `Target ${index} url "${url}" must be a valid http or https URL.`,
    );
  }
  if (!Number.isSafeInteger(target.weight) || target.weight < 1 || target.weight > 100) {
    throw new ZelavisEdgeValidationError(
      `Target ${index} weight must be an integer between 1 and 100.`,
    );
  }
  if (
    target.placementGeneration !== undefined &&
    (!Number.isSafeInteger(target.placementGeneration) || target.placementGeneration < 0)
  ) {
    throw new ZelavisEdgeValidationError(
      `Target ${index} placementGeneration must be a non-negative safe integer.`,
    );
  }
  return {
    url,
    weight: target.weight,
    ...(target.placementGeneration !== undefined
      ? { placementGeneration: target.placementGeneration }
      : {}),
    ...(target.nodeId ? { nodeId: target.nodeId.trim() } : {}),
  };
}

function validateHealthCheck(check: ZelavisEdgeHealthCheckPolicy): ZelavisEdgeHealthCheckPolicy {
  if (!check.path || typeof check.path !== "string") {
    throw new ZelavisEdgeValidationError(
      "Health check requires a non-empty path.",
    );
  }
  for (const [field, value] of [
    ["intervalMs", check.intervalMs],
    ["timeoutMs", check.timeoutMs],
    ["unhealthyThreshold", check.unhealthyThreshold],
    ["healthyThreshold", check.healthyThreshold],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ZelavisEdgeValidationError(
        `Health check ${field} must be a positive integer.`,
      );
    }
  }
  return {
    path: check.path.trim(),
    intervalMs: check.intervalMs,
    timeoutMs: check.timeoutMs,
    unhealthyThreshold: check.unhealthyThreshold,
    healthyThreshold: check.healthyThreshold,
  };
}

function validateRoute(route: ZelavisEdgeRoute): ZelavisEdgeRoute {
  const id = normalizeRouteId(route.id);
  validateScope(route.scope, route.projectId, "Route");
  const hostname = normalizeHostValue(route.hostname);
  const pathPrefix = route.pathPrefix?.trim();
  if (!pathPrefix || !pathPrefix.startsWith("/")) {
    throw new ZelavisEdgeValidationError(
      `Route pathPrefix must start with "/".`,
    );
  }
  if (!VALID_PATH_MATCHES.includes(route.pathMatch as "prefix" | "exact")) {
    throw new ZelavisEdgeValidationError(
      `Route pathMatch must be "prefix" or "exact".`,
    );
  }
  if (!Array.isArray(route.targets) || route.targets.length === 0) {
    throw new ZelavisEdgeValidationError(
      "Route requires at least one target.",
    );
  }
  const targets = route.targets.map((target, index) => validateTarget(target, index));
  const protocols = [...new Set(route.protocols)];
  for (const protocol of protocols) {
    if (!VALID_PROTOCOLS.includes(protocol)) {
      throw new ZelavisEdgeValidationError(
        `Unknown route protocol "${protocol}".`,
      );
    }
  }
  if (
    route.timeoutMs !== undefined &&
    (!Number.isSafeInteger(route.timeoutMs) || route.timeoutMs < 0)
  ) {
    throw new ZelavisEdgeValidationError(
      "Route timeoutMs must be a non-negative safe integer.",
    );
  }
  if (
    route.maxRequestBodyBytes !== undefined &&
    (!Number.isSafeInteger(route.maxRequestBodyBytes) || route.maxRequestBodyBytes < 0)
  ) {
    throw new ZelavisEdgeValidationError(
      "Route maxRequestBodyBytes must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(route.priority)) {
    throw new ZelavisEdgeValidationError(
      "Route priority must be a safe integer.",
    );
  }
  return {
    id,
    scope: route.scope,
    ...(route.projectId ? { projectId: route.projectId.trim() } : {}),
    hostname,
    pathPrefix,
    pathMatch: route.pathMatch,
    targets,
    protocols,
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
    ...(route.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: route.maxRequestBodyBytes }
      : {}),
    ...(route.healthCheck
      ? { healthCheck: validateHealthCheck(route.healthCheck) }
      : {}),
    priority: route.priority,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Store value readers — deserialize from System Store
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHostname(value: unknown): ZelavisEdgeHostname {
  if (
    !isRecord(value) ||
    typeof value.host !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.tlsMode !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new ZelavisEdgeValidationError("Stored Edge hostname is invalid.");
  }
  return validateHostname(value as unknown as ZelavisEdgeHostname);
}

function readRoute(value: unknown): ZelavisEdgeRoute {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.pathPrefix !== "string" ||
    typeof value.pathMatch !== "string" ||
    !Array.isArray(value.targets) ||
    !Array.isArray(value.protocols) ||
    typeof value.priority !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new ZelavisEdgeValidationError("Stored Edge route is invalid.");
  }
  return validateRoute(value as unknown as ZelavisEdgeRoute);
}

function readPublication(value: unknown): ZelavisEdgeCompiledPublication {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.revision !== "number" ||
    typeof value.compiledAt !== "string" ||
    !Array.isArray(value.hostnames) ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.requiredCapabilities) ||
    !Array.isArray(value.certificateRefs) ||
    typeof value.routeCount !== "number"
  ) {
    throw new ZelavisEdgeValidationError(
      "Stored Edge publication is invalid.",
    );
  }
  return value as unknown as ZelavisEdgeCompiledPublication;
}

function readCurrentPointer(value: unknown): { revision: number } {
  if (!isRecord(value) || typeof value.revision !== "number") {
    throw new ZelavisEdgeValidationError(
      "Stored Edge publication pointer is invalid.",
    );
  }
  return { revision: value.revision };
}

function storeValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

/**
 * Derive the Edge capabilities required to serve a set of routes and
 * hostnames. The derivation is deterministic: same input produces the
 * same sorted capability list.
 */
export function deriveEdgeCapabilities(
  routes: readonly ZelavisEdgeRoute[],
  hostnames: readonly ZelavisEdgeHostname[],
): ZelavisEdgeCapability[] {
  const capabilities = new Set<ZelavisEdgeCapability>();

  // HTTP is always required when routes exist.
  if (routes.length > 0) {
    capabilities.add("http");
  }

  // TLS modes.
  for (const hostname of hostnames) {
    if (hostname.tlsMode === "managed") {
      capabilities.add("https");
      capabilities.add("certificate-hot-reload");
    } else if (hostname.tlsMode === "external") {
      capabilities.add("https");
    }
  }

  for (const route of routes) {
    // Protocol capabilities.
    for (const protocol of route.protocols) {
      if (protocol === "websocket") capabilities.add("websocket");
      if (protocol === "sse") capabilities.add("sse");
      // gRPC runs over HTTP/2 — no separate gRPC capability.
    }

    // Weighted targets.
    if (route.targets.length > 1) {
      const weights = new Set(route.targets.map((t) => t.weight));
      if (weights.size > 1) {
        capabilities.add("weighted-targets");
      }
    }

    // Active health checks.
    if (route.healthCheck) {
      capabilities.add("active-health-checks");
    }
  }

  return [...capabilities].sort();
}

// ---------------------------------------------------------------------------
// Publication summary bridge
// ---------------------------------------------------------------------------

/**
 * Extract a {@link ZelavisEdgePublication} summary from a compiled
 * publication. This bridges the route store output to the existing Edge
 * manager input — no changes to the manager needed.
 */
export function toPublicationSummary(
  compiled: ZelavisEdgeCompiledPublication,
): ZelavisEdgePublication {
  return {
    id: "zelavis-edge-routes",
    revision: String(compiled.revision),
    routeCount: compiled.routeCount,
    requiredCapabilities: compiled.requiredCapabilities,
    certificateRefs: compiled.certificateRefs,
  };
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export interface CreateZelavisEdgeRouteStoreOptions {
  store: ZelavisSystemStore;
  now?: () => Date;
}

export function createZelavisEdgeRouteStore(
  options: CreateZelavisEdgeRouteStoreOptions,
): ZelavisEdgeRouteStore {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const timestamp = () => now().toISOString();

  // -- Hostname operations --------------------------------------------------

  async function putHostname(
    input: ZelavisEdgeHostname,
  ): Promise<ZelavisEdgeHostname> {
    const validated = validateHostname(input);
    const existing = await store.get(HOSTNAMES_NAMESPACE, validated.host);
    if (existing) {
      const updated: ZelavisEdgeHostname = {
        ...validated,
        createdAt: readHostname(existing.value).createdAt,
        updatedAt: timestamp(),
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        const record = await store.get(HOSTNAMES_NAMESPACE, validated.host);
        if (!record) {
          // Deleted concurrently — insert instead.
          break;
        }
        const written = await store.compareAndSet(
          HOSTNAMES_NAMESPACE,
          validated.host,
          record.updatedAt,
          storeValue(updated),
          record.value,
        );
        if (written) return updated;
      }
    }
    const created: ZelavisEdgeHostname = {
      ...validated,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    const result = await store.setIfAbsent(
      HOSTNAMES_NAMESPACE,
      validated.host,
      storeValue(created),
    );
    if (result.created) return created;
    // Lost the race — retry as an update.
    return putHostname(input);
  }

  async function getHostname(
    host: string,
  ): Promise<ZelavisEdgeHostname | undefined> {
    const normalized = normalizeHostValue(host);
    const record = await store.get(HOSTNAMES_NAMESPACE, normalized);
    return record ? readHostname(record.value) : undefined;
  }

  async function deleteHostname(host: string): Promise<boolean> {
    const normalized = normalizeHostValue(host);
    return store.delete(HOSTNAMES_NAMESPACE, normalized);
  }

  async function listHostnames(
    filter?: { scope?: "platform" | "project"; projectId?: string },
  ): Promise<readonly ZelavisEdgeHostname[]> {
    const records = await store.list(HOSTNAMES_NAMESPACE);
    const hostnames: ZelavisEdgeHostname[] = [];
    for (const record of records) {
      const hostname = readHostname(record.value);
      if (filter?.scope && hostname.scope !== filter.scope) continue;
      if (filter?.projectId && hostname.projectId !== filter.projectId) continue;
      hostnames.push(hostname);
    }
    return hostnames;
  }

  // -- Route operations -----------------------------------------------------

  async function putRoute(input: ZelavisEdgeRoute): Promise<ZelavisEdgeRoute> {
    const validated = validateRoute(input);
    const existing = await store.get(ROUTES_NAMESPACE, validated.id);
    if (existing) {
      const updated: ZelavisEdgeRoute = {
        ...validated,
        createdAt: readRoute(existing.value).createdAt,
        updatedAt: timestamp(),
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        const record = await store.get(ROUTES_NAMESPACE, validated.id);
        if (!record) break;
        const written = await store.compareAndSet(
          ROUTES_NAMESPACE,
          validated.id,
          record.updatedAt,
          storeValue(updated),
          record.value,
        );
        if (written) return updated;
      }
    }
    const created: ZelavisEdgeRoute = {
      ...validated,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    const result = await store.setIfAbsent(
      ROUTES_NAMESPACE,
      validated.id,
      storeValue(created),
    );
    if (result.created) return created;
    return putRoute(input);
  }

  async function getRoute(
    id: string,
  ): Promise<ZelavisEdgeRoute | undefined> {
    const normalized = normalizeRouteId(id);
    const record = await store.get(ROUTES_NAMESPACE, normalized);
    return record ? readRoute(record.value) : undefined;
  }

  async function deleteRoute(id: string): Promise<boolean> {
    const normalized = normalizeRouteId(id);
    return store.delete(ROUTES_NAMESPACE, normalized);
  }

  async function listRoutes(
    filter?: {
      scope?: "platform" | "project";
      projectId?: string;
      hostname?: string;
    },
  ): Promise<readonly ZelavisEdgeRoute[]> {
    const records = await store.list(ROUTES_NAMESPACE);
    const routes: ZelavisEdgeRoute[] = [];
    for (const record of records) {
      const route = readRoute(record.value);
      if (filter?.scope && route.scope !== filter.scope) continue;
      if (filter?.projectId && route.projectId !== filter.projectId) continue;
      if (filter?.hostname && route.hostname !== filter.hostname) continue;
      routes.push(route);
    }
    // Sort by priority descending, then id ascending for determinism.
    routes.sort((a, b) =>
      a.priority !== b.priority
        ? b.priority - a.priority
        : a.id.localeCompare(b.id),
    );
    return routes;
  }

  async function deleteProjectRoutes(projectId: string): Promise<number> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      throw new ZelavisEdgeValidationError(
        "Project id is required to delete project routes.",
      );
    }
    let deleted = 0;
    // Delete routes scoped to this project.
    const routeRecords = await store.list(ROUTES_NAMESPACE);
    for (const record of routeRecords) {
      const route = readRoute(record.value);
      if (route.projectId === normalizedProjectId) {
        if (await store.delete(ROUTES_NAMESPACE, route.id)) {
          deleted += 1;
        }
      }
    }
    // Delete hostnames scoped to this project.
    const hostnameRecords = await store.list(HOSTNAMES_NAMESPACE);
    for (const record of hostnameRecords) {
      const hostname = readHostname(record.value);
      if (hostname.projectId === normalizedProjectId) {
        if (await store.delete(HOSTNAMES_NAMESPACE, hostname.host)) {
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  // -- Publication operations -----------------------------------------------

  async function compile(): Promise<ZelavisEdgeCompiledPublication> {
    const hostnames = (await listHostnames()) as ZelavisEdgeHostname[];
    const routes = (await listRoutes()) as ZelavisEdgeRoute[];
    const requiredCapabilities = deriveEdgeCapabilities(routes, hostnames);
    const certificateRefs = [
      ...new Set(
        hostnames
          .map((h) => h.certificateRef)
          .filter((ref): ref is string => typeof ref === "string"),
      ),
    ].sort();

    // Advance the revision counter atomically.
    for (let attempt = 0; attempt < 5; attempt++) {
      const pointerRecord = await store.get(
        PUBLICATIONS_NAMESPACE,
        CURRENT_PUBLICATION_KEY,
      );

      const currentRevision = pointerRecord
        ? readCurrentPointer(pointerRecord.value).revision
        : 0;
      const nextRevision = currentRevision + 1;

      const publication: ZelavisEdgeCompiledPublication = {
        schemaVersion: 1,
        revision: nextRevision,
        compiledAt: timestamp(),
        hostnames,
        routes,
        requiredCapabilities,
        certificateRefs,
        routeCount: routes.length,
      };

      // Store the publication snapshot.
      await store.set(
        PUBLICATIONS_NAMESPACE,
        String(nextRevision),
        storeValue(publication),
      );

      // Advance the current pointer atomically.
      if (pointerRecord) {
        const written = await store.compareAndSet(
          PUBLICATIONS_NAMESPACE,
          CURRENT_PUBLICATION_KEY,
          pointerRecord.updatedAt,
          storeValue({ revision: nextRevision }),
          pointerRecord.value,
        );
        if (written) return publication;
        // CAS failed — another compilation happened concurrently. Retry.
      } else {
        const result = await store.setIfAbsent(
          PUBLICATIONS_NAMESPACE,
          CURRENT_PUBLICATION_KEY,
          storeValue({ revision: nextRevision }),
        );
        if (result.created) return publication;
        // Lost the race. Retry.
      }
    }
    throw new ZelavisEdgeValidationError(
      "Edge route publication revision advanced repeatedly during compilation.",
    );
  }

  async function getPublication(
    revision: number,
  ): Promise<ZelavisEdgeCompiledPublication | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ZelavisEdgeValidationError(
        "Publication revision must be a positive integer.",
      );
    }
    const record = await store.get(
      PUBLICATIONS_NAMESPACE,
      String(revision),
    );
    return record ? readPublication(record.value) : undefined;
  }

  async function getCurrentPublication(): Promise<
    ZelavisEdgeCompiledPublication | undefined
  > {
    const pointerRecord = await store.get(
      PUBLICATIONS_NAMESPACE,
      CURRENT_PUBLICATION_KEY,
    );
    if (!pointerRecord) return undefined;
    const { revision } = readCurrentPointer(pointerRecord.value);
    return getPublication(revision);
  }

  return {
    putHostname,
    getHostname,
    deleteHostname,
    listHostnames,
    putRoute,
    getRoute,
    deleteRoute,
    listRoutes,
    deleteProjectRoutes,
    compile,
    getPublication,
    getCurrentPublication,
  };
}
