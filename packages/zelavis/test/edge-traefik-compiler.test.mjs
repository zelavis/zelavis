import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileTraefikPublication,
  writeTraefikGeneration,
  TRAEFIK_SUPPORTED_CAPABILITIES,
  ZelavisEdgeValidationError,
} from "../dist/index.js";

function makePublication(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    compiledAt: "2026-09-20T00:00:00.000Z",
    hostnames: [],
    routes: [],
    requiredCapabilities: ["http"],
    certificateRefs: [],
    routeCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Golden Test 1: Empty publication (no routes)
// ---------------------------------------------------------------------------

test("Traefik compiler compiles an empty publication into valid no-route output", () => {
  const publication = makePublication({
    requiredCapabilities: [],
  });

  const result = compileTraefikPublication(publication);

  assert.equal(result.generation, "rev-1");
  assert.equal(result.revision, 1);
  assert.equal(result.manifest.routerCount, 0);
  assert.equal(result.manifest.serviceCount, 0);
  assert.equal(result.manifest.certificateCount, 0);
  assert.ok(result.manifest.contentHash);

  const parsedConfig = JSON.parse(result.files["traefik-dynamic.json"]);
  assert.deepEqual(parsedConfig, {
    http: {
      routers: {},
      services: {},
    },
  });

  const parsedManifest = JSON.parse(result.files["manifest.json"]);
  assert.equal(parsedManifest.revision, 1);
  assert.equal(parsedManifest.routerCount, 0);
});

// ---------------------------------------------------------------------------
// Golden Test 2: Platform routes with managed TLS and redirect
// ---------------------------------------------------------------------------

test("Traefik compiler generates HTTPS router, HTTP redirect, and certificate binding for managed TLS", () => {
  const publication = makePublication({
    hostnames: [
      {
        host: "platform.example.com",
        scope: "platform",
        tlsMode: "managed",
        certificateRef: "cert:platform.example.com",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    routes: [
      {
        id: "platform:dashboard",
        scope: "platform",
        hostname: "platform.example.com",
        pathPrefix: "/",
        pathMatch: "prefix",
        targets: [{ url: "http://127.0.0.1:3000", weight: 100 }],
        protocols: ["http"],
        priority: 0,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    requiredCapabilities: ["http", "https", "certificate-hot-reload"],
    certificateRefs: ["cert:platform.example.com"],
    routeCount: 1,
  });

  const result = compileTraefikPublication(publication, {
    certificateDirectory: "/etc/zelavis/certs",
  });

  assert.equal(result.manifest.routerCount, 2); // 1 https + 1 http redirect
  assert.equal(result.manifest.serviceCount, 1);
  assert.equal(result.manifest.certificateCount, 1);

  const config = result.configuration;

  // HTTPS router
  const httpsRouter = config.http.routers["router_platform_platform_dashboard_https"];
  assert.ok(httpsRouter);
  assert.deepEqual(httpsRouter.entryPoints, ["websecure"]);
  assert.equal(httpsRouter.rule, "Host(`platform.example.com`)");
  assert.equal(httpsRouter.service, "svc_platform_platform_dashboard");
  assert.deepEqual(httpsRouter.tls, {});

  // HTTP redirect router
  const redirectRouter = config.http.routers["router_platform_platform_dashboard_redirect"];
  assert.ok(redirectRouter);
  assert.deepEqual(redirectRouter.entryPoints, ["web"]);
  assert.equal(redirectRouter.rule, "Host(`platform.example.com`)");
  assert.deepEqual(redirectRouter.middlewares, ["middleware_redirect_https"]);

  // Redirect middleware
  assert.deepEqual(config.http.middlewares?.middleware_redirect_https, {
    redirectScheme: {
      scheme: "https",
      permanent: true,
    },
  });

  // Service
  const service = config.http.services["svc_platform_platform_dashboard"];
  assert.ok(service);
  assert.deepEqual(service.loadBalancer.servers, [{ url: "http://127.0.0.1:3000" }]);

  // TLS certificates
  assert.ok(config.tls?.certificates);
  assert.deepEqual(config.tls.certificates, [
    {
      certFile: "/etc/zelavis/certs/cert_platform_example_com.crt",
      keyFile: "/etc/zelavis/certs/cert_platform_example_com.key",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Golden Test 3: Project routes (plain HTTP, path matching, priority)
// ---------------------------------------------------------------------------

test("Traefik compiler compiles project routes with prefix, exact match, and priorities", () => {
  const publication = makePublication({
    hostnames: [
      {
        host: "app.example.com",
        scope: "project",
        projectId: "my-app",
        tlsMode: "none",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    routes: [
      {
        id: "project:my-app:root",
        scope: "project",
        projectId: "my-app",
        hostname: "app.example.com",
        pathPrefix: "/",
        pathMatch: "prefix",
        targets: [{ url: "http://127.0.0.1:5000", weight: 100 }],
        protocols: ["http"],
        priority: 1,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "project:my-app:api",
        scope: "project",
        projectId: "my-app",
        hostname: "app.example.com",
        pathPrefix: "/api",
        pathMatch: "prefix",
        targets: [{ url: "http://127.0.0.1:5001", weight: 100 }],
        protocols: ["http"],
        priority: 10,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "project:my-app:health",
        scope: "project",
        projectId: "my-app",
        hostname: "app.example.com",
        pathPrefix: "/healthz",
        pathMatch: "exact",
        targets: [{ url: "http://127.0.0.1:5002", weight: 100 }],
        protocols: ["http"],
        priority: 50,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    requiredCapabilities: ["http"],
    routeCount: 3,
  });

  const result = compileTraefikPublication(publication);
  const config = result.configuration;

  // Plain HTTP routers (no TLS)
  assert.equal(Object.keys(config.http.routers).length, 3);
  assert.equal(config.tls, undefined);

  // Root router
  const rootRouter = config.http.routers["router_project_project_my-app_root_http"];
  assert.equal(rootRouter.rule, "Host(`app.example.com`)");
  assert.equal(rootRouter.priority, 1);

  // API router (prefix match)
  const apiRouter = config.http.routers["router_project_project_my-app_api_http"];
  assert.equal(apiRouter.rule, "Host(`app.example.com`) && PathPrefix(`/api`)");
  assert.equal(apiRouter.priority, 10);

  // Health router (exact match)
  const healthRouter = config.http.routers["router_project_project_my-app_health_http"];
  assert.equal(healthRouter.rule, "Host(`app.example.com`) && Path(`/healthz`)");
  assert.equal(healthRouter.priority, 50);
});

// ---------------------------------------------------------------------------
// Golden Test 4: WebSockets & SSE capabilities
// ---------------------------------------------------------------------------

test("Traefik compiler compiles WebSocket and SSE routes successfully", () => {
  const publication = makePublication({
    hostnames: [
      {
        host: "realtime.example.com",
        scope: "project",
        projectId: "rt",
        tlsMode: "none",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    routes: [
      {
        id: "project:rt:events",
        scope: "project",
        projectId: "rt",
        hostname: "realtime.example.com",
        pathPrefix: "/events",
        pathMatch: "prefix",
        targets: [{ url: "http://127.0.0.1:8000", weight: 100 }],
        protocols: ["http", "websocket", "sse"],
        priority: 0,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    requiredCapabilities: ["http", "websocket", "sse"],
    routeCount: 1,
  });

  const result = compileTraefikPublication(publication);
  assert.equal(result.manifest.routerCount, 1);
  assert.equal(result.manifest.serviceCount, 1);
  assert.deepEqual(result.requiredCapabilities, ["http", "websocket", "sse"]);
});

// ---------------------------------------------------------------------------
// Golden Test 5: Weighted targets, health checks, and body buffering
// ---------------------------------------------------------------------------

test("Traefik compiler compiles weighted targets, health checks, and buffering middleware", () => {
  const publication = makePublication({
    hostnames: [
      {
        host: "heavy.example.com",
        scope: "platform",
        tlsMode: "none",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    routes: [
      {
        id: "platform:balanced",
        scope: "platform",
        hostname: "heavy.example.com",
        pathPrefix: "/",
        pathMatch: "prefix",
        targets: [
          { url: "http://127.0.0.1:9001", weight: 80 },
          { url: "http://127.0.0.1:9002", weight: 20 },
        ],
        protocols: ["http"],
        healthCheck: {
          path: "/healthz",
          intervalMs: 15000,
          timeoutMs: 3000,
          unhealthyThreshold: 3,
          healthyThreshold: 2,
        },
        maxRequestBodyBytes: 10485760, // 10MB
        priority: 0,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    requiredCapabilities: ["http", "weighted-targets", "active-health-checks"],
    routeCount: 1,
  });

  const result = compileTraefikPublication(publication);
  const config = result.configuration;

  // Weighted servers
  const service = config.http.services["svc_platform_platform_balanced"];
  assert.deepEqual(service.loadBalancer.servers, [
    { url: "http://127.0.0.1:9001", weight: 80 },
    { url: "http://127.0.0.1:9002", weight: 20 },
  ]);

  // Health check
  assert.deepEqual(service.loadBalancer.healthCheck, {
    path: "/healthz",
    interval: "15000ms",
    timeout: "3000ms",
  });

  // Buffering middleware
  const middlewareName = "middleware_buffer_platform_balanced";
  assert.ok(config.http.middlewares?.[middlewareName]);
  assert.deepEqual(config.http.middlewares[middlewareName], {
    buffering: {
      maxRequestBodyBytes: 10485760,
    },
  });

  // Attached to router
  const router = config.http.routers["router_platform_platform_balanced_http"];
  assert.deepEqual(router.middlewares, [middlewareName]);
});

// ---------------------------------------------------------------------------
// Golden Test 6: Rejection of unsupported capabilities
// ---------------------------------------------------------------------------

test("Traefik compiler rejects publications requiring unsupported capabilities", () => {
  const publication = makePublication({
    requiredCapabilities: ["http", "udp"], // Traefik HTTP dynamic compiler doesn't support raw udp
  });

  assert.throws(
    () => compileTraefikPublication(publication),
    (err) => {
      assert.ok(err instanceof ZelavisEdgeValidationError);
      assert.match(err.message, /cannot satisfy required capability "udp"/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Golden Test 7: Deterministic disk writing
// ---------------------------------------------------------------------------

test("writeTraefikGeneration writes dynamic configuration and manifest to disk", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "zelavis-traefik-test-"));
  try {
    const publication = makePublication({
      hostnames: [
        {
          host: "disk.example.com",
          scope: "platform",
          tlsMode: "none",
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      routes: [
        {
          id: "platform:test",
          scope: "platform",
          hostname: "disk.example.com",
          pathPrefix: "/",
          pathMatch: "prefix",
          targets: [{ url: "http://127.0.0.1:3000", weight: 100 }],
          protocols: ["http"],
          priority: 0,
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      requiredCapabilities: ["http"],
      routeCount: 1,
    });

    const generation = compileTraefikPublication(publication, { generation: "gen-42" });
    await writeTraefikGeneration(generation, tmp);

    const dynamicContent = await readFile(join(tmp, "traefik-dynamic.json"), "utf8");
    const manifestContent = await readFile(join(tmp, "manifest.json"), "utf8");

    assert.equal(dynamicContent, generation.files["traefik-dynamic.json"]);
    assert.equal(manifestContent, generation.files["manifest.json"]);

    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.generation, "gen-42");
    assert.equal(manifest.revision, 1);
    assert.equal(manifest.routerCount, 1);
    assert.equal(manifest.serviceCount, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
