/**
 * Reference Caddy v2 Edge Adapter fixture for conformance testing.
 *
 * Demonstrates proxy-neutral consumption of canonical Zelavis route
 * publications by translating them into native Caddy JSON configuration.
 */

export function compileCaddyPublication(publication) {
  const routes = [];
  const tlsSniMatches = [];

  // 1. Process hostnames for TLS
  for (const hostname of publication.hostnames ?? []) {
    if (hostname.tlsMode === "managed" || hostname.tlsMode === "external") {
      tlsSniMatches.push(hostname.host);
    }
  }

  // 2. Process routes
  for (const route of publication.routes ?? []) {
    const match = {
      host: [route.hostname],
    };

    if (route.pathPrefix && route.pathPrefix !== "/") {
      match.path = route.pathMatch === "exact"
        ? [route.pathPrefix]
        : [`${route.pathPrefix.replace(/\/$/, "")}/*`];
    }

    const upstreams = (route.targets ?? []).map((target) => {
      const url = new URL(target.url);
      return {
        dial: `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`,
        weight: target.weight ?? 1,
      };
    });

    const handler = {
      handler: "reverse_proxy",
      upstreams,
    };

    if (route.healthCheck) {
      handler.health_checks = {
        active: {
          path: route.healthCheck.path,
          interval: `${route.healthCheck.intervalMs}ms`,
          timeout: `${route.healthCheck.timeoutMs}ms`,
        },
      };
    }

    routes.push({
      match: [match],
      handle: [handler],
      terminal: true,
    });
  }

  const caddyConfig = {
    apps: {
      http: {
        servers: {
          zelavis: {
            listen: [":443", ":80"],
            routes,
            tls_connection_policies: tlsSniMatches.length > 0
              ? [{ match: { sni: tlsSniMatches } }]
              : [],
          },
        },
      },
    },
  };

  return {
    generation: String(publication.revision),
    config: caddyConfig,
    configJson: JSON.stringify(caddyConfig, null, 2),
  };
}

export function createCaddyEdgeAdapter(options = {}) {
  const events = options.events ?? [];
  let stagedConfig = null;
  let activeConfig = null;
  let previousConfig = null;

  return {
    id: "caddy",
    title: "Caddy",
    capabilities: [
      "http",
      "https",
      "websocket",
      "sse",
      "weighted-targets",
      "active-health-checks",
      "connection-draining",
      "certificate-hot-reload",
    ],

    async detect() {
      events.push("caddy:detect");
      if (options.detectionError) {
        return {
          state: "unavailable",
          installed: false,
          healthy: false,
          checkedAt: new Date().toISOString(),
          detail: options.detectionError,
        };
      }
      return {
        state: "available",
        installed: true,
        healthy: true,
        checkedAt: new Date().toISOString(),
        version: "2.8.4",
      };
    },

    async stage(context) {
      events.push(`caddy:stage:${context.switchId}`);
      stagedConfig = compileCaddyPublication(context.publication);
    },

    async verify(context) {
      events.push(`caddy:verify:${context.switchId}`);
      if (options.failVerification) {
        return {
          ready: false,
          detail: typeof options.failVerification === "string"
            ? options.failVerification
            : "Synthetic Caddy verification probe failed",
        };
      }
      return {
        ready: true,
        detail: `Caddy configuration for generation ${context.publication.revision} validated.`,
      };
    },

    async activate(context) {
      events.push(`caddy:activate:${context.switchId}`);
      previousConfig = activeConfig;
      activeConfig = stagedConfig;
      stagedConfig = null;
    },

    async drain(context) {
      events.push(`caddy:drain:${context.switchId}`);
      // Connection drain logic
    },

    async rollback(context) {
      events.push(`caddy:rollback:${context.switchId}`);
      activeConfig = previousConfig;
      stagedConfig = null;
    },

    // Test accessors
    getActiveConfig() {
      return activeConfig;
    },
    getStagedConfig() {
      return stagedConfig;
    },
  };
}
