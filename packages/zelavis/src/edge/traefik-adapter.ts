import type {
  ZelavisEdgeAdapter,
  ZelavisEdgeAdapterContext,
  ZelavisEdgeAdapterDetection,
  ZelavisEdgeAdapterVerification,
  ZelavisEdgeCertificateDistributor,
} from "./index.js";
import {
  compileTraefikPublication,
  TRAEFIK_SUPPORTED_CAPABILITIES,
} from "./traefik-compiler.js";
import type {
  ZelavisEdgeCompiledPublication,
  ZelavisEdgeRouteStore,
} from "./routes.js";

export interface ZelavisEdgeOperationInvoker {
  execute(
    operationId: string,
    args: Record<string, string>,
  ): Promise<Record<string, unknown>>;
}

export interface CreateAgentHostOperationInvokerOptions {
  broker: {
    submit(
      input: { operation: string; arguments?: Record<string, string> },
      principal?: any,
    ): Promise<{ operationId: string }>;
  };
  agent: {
    getHostOperation(
      operationId: string,
    ): Promise<
      | {
          status: string;
          result?: unknown;
          error?: { message?: string };
        }
      | undefined
    >;
  };
  principal?: any;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * Creates a ZelavisEdgeOperationInvoker from a host operation broker and Agent IPC client.
 */
export function createAgentHostOperationInvoker(
  options: CreateAgentHostOperationInvokerOptions,
): ZelavisEdgeOperationInvoker {
  const principal = options.principal ?? {
    id: "system:platform:edge",
    type: "system",
    permissions: ["*"],
  };
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async execute(operationId: string, args: Record<string, string>) {
      const record = await options.broker.submit(
        { operation: operationId, arguments: args },
        principal,
      );
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const summary = await options.agent.getHostOperation(
          record.operationId,
        );
        if (
          summary &&
          (summary.status === "succeeded" || summary.status === "failed")
        ) {
          if (summary.status === "failed") {
            throw new Error(
              summary.error?.message ??
                `Host operation "${operationId}" failed.`,
            );
          }
          return (summary.result ?? {}) as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      throw new Error(`Host operation "${operationId}" timed out.`);
    },
  };
}

export interface TraefikEdgeAdapterOptions {
  /** Injected host operation invoker executing signed Agent operations. */
  invoker: ZelavisEdgeOperationInvoker;
  /** Optional route store to fetch full compiled publications by revision. */
  routeStore?: ZelavisEdgeRouteStore;
  /** Custom base directory for Traefik files. Defaults to "/var/lib/zelavis/edge/traefik". */
  baseDir?: string;
  /** Custom systemd unit name. Defaults to "zelavis-traefik.service". */
  unitName?: string;
  /** Drain duration in milliseconds. Defaults to 2000. */
  drainDurationMs?: number;
}

export interface TraefikCertificateDistributorOptions {
  invoker: ZelavisEdgeOperationInvoker;
  baseDir?: string;
  /** Resolver to fetch certificate and private key PEM material for opaque refs. */
  certificateResolver?: (
    ref: string,
  ) => Promise<{ certPem: string; keyPem: string } | undefined>;
}

/**
 * Creates a ZelavisEdgeAdapter backed by signed Agent host operations for Traefik v3.
 */
export function createTraefikEdgeAdapter(
  options: TraefikEdgeAdapterOptions,
): ZelavisEdgeAdapter {
  const {
    invoker,
    routeStore,
    baseDir = "/var/lib/zelavis/edge/traefik",
    unitName = "zelavis-traefik.service",
    drainDurationMs = 2000,
  } = options;

  return {
    id: "traefik",
    title: "Traefik",
    capabilities: TRAEFIK_SUPPORTED_CAPABILITIES,

    async detect(): Promise<ZelavisEdgeAdapterDetection> {
      try {
        const result = await invoker.execute("zelavis.edge-unit-control", {
          action: "status",
          unit: unitName,
        });

        const active = Boolean(result.active);
        const status = String(result.status ?? "unknown");

        return {
          state: active || status === "inactive" || status === "success" || status === "not_installed"
            ? "available"
            : "unavailable",
          installed: status !== "not_installed",
          healthy: active || status === "inactive" || status === "success",
          checkedAt: new Date().toISOString(),
          version: "3.7.13",
          detail: status,
        };
      } catch (error) {
        return {
          state: "unavailable",
          installed: false,
          healthy: false,
          checkedAt: new Date().toISOString(),
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async stage(context: ZelavisEdgeAdapterContext): Promise<void> {
      const pub = context.publication;
      let compiled: ZelavisEdgeCompiledPublication | undefined;

      // If full compiled publication was passed in context
      if ("routes" in pub && Array.isArray((pub as unknown as ZelavisEdgeCompiledPublication).routes)) {
        compiled = pub as unknown as ZelavisEdgeCompiledPublication;
      } else if (routeStore) {
        const revNumber = Number(pub.revision.replace(/^rev-/, ""));
        compiled = await routeStore.getPublication(isNaN(revNumber) ? 1 : revNumber);
      }

      // If no compiled publication found, compile empty publication
      if (!compiled) {
        compiled = {
          schemaVersion: 1,
          revision: Number(pub.revision.replace(/^rev-/, "")) || 1,
          compiledAt: new Date().toISOString(),
          hostnames: [],
          routes: [],
          requiredCapabilities: pub.requiredCapabilities ?? [],
          certificateRefs: pub.certificateRefs ?? [],
          routeCount: pub.routeCount ?? 0,
        };
      }

      const generationResult = compileTraefikPublication(compiled, {
        generation: pub.revision,
        certificateDirectory: `${baseDir}/certs`,
      });

      const dynamicConfig = generationResult.files["traefik-dynamic.json"];
      const manifestJson = generationResult.files["manifest.json"];

      await invoker.execute("zelavis.edge-stage", {
        generation: pub.revision,
        "base-dir": baseDir,
        "config-json": dynamicConfig,
        "manifest-json": manifestJson,
      });
    },

    async verify(
      context: ZelavisEdgeAdapterContext,
    ): Promise<ZelavisEdgeAdapterVerification> {
      try {
        const result = await invoker.execute("zelavis.edge-validate", {
          generation: context.publication.revision,
          "base-dir": baseDir,
        });

        if (!result.valid) {
          return {
            ready: false,
            detail: String(result.error ?? "Offline validation failed"),
          };
        }

        return { ready: true };
      } catch (error) {
        return {
          ready: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async activate(context: ZelavisEdgeAdapterContext): Promise<void> {
      // 1. Atomic active-generation exchange
      const activateResult = await invoker.execute("zelavis.edge-activate", {
        generation: context.publication.revision,
        "base-dir": baseDir,
      });

      if (activateResult.status !== "activated") {
        throw new Error(
          `Failed to activate generation ${context.publication.revision}: ${activateResult.error ?? "unknown error"}`,
        );
      }

      // 2. Unit reload or start
      await invoker.execute("zelavis.edge-unit-control", {
        action: "reload",
        unit: unitName,
      });
    },

    async drain(context: ZelavisEdgeAdapterContext): Promise<void> {
      await invoker.execute("zelavis.edge-drain", {
        "duration-ms": String(drainDurationMs),
        ...(context.previousAdapterId ? { "previous-adapter": context.previousAdapterId } : {}),
      });
    },

    async rollback(context: ZelavisEdgeAdapterContext): Promise<void> {
      await invoker.execute("zelavis.edge-rollback", {
        "base-dir": baseDir,
      });

      await invoker.execute("zelavis.edge-unit-control", {
        action: "reload",
        unit: unitName,
      });
    },
  };
}

/**
 * Creates a ZelavisEdgeCertificateDistributor backed by signed Agent host operations.
 */
export function createTraefikCertificateDistributor(
  options: TraefikCertificateDistributorOptions,
): ZelavisEdgeCertificateDistributor {
  const {
    invoker,
    baseDir = "/var/lib/zelavis/edge/traefik",
    certificateResolver,
  } = options;

  return {
    async stage(context: ZelavisEdgeAdapterContext): Promise<void> {
      if (!certificateResolver || context.publication.certificateRefs.length === 0) {
        return;
      }

      for (const ref of context.publication.certificateRefs) {
        const cert = await certificateResolver(ref);
        if (cert) {
          const safeName = ref.replace(/[^a-zA-Z0-9_-]/g, "_");
          await invoker.execute("zelavis.edge-stage", {
            generation: context.publication.revision,
            "base-dir": baseDir,
            "cert-name": safeName,
            "cert-pem": cert.certPem,
            "key-pem": cert.keyPem,
          });
        }
      }
    },

    async activate(_context: ZelavisEdgeAdapterContext): Promise<void> {
      // Certificates were staged with 0644/0600 permissions into baseDir/certs
      // and become readable to the Traefik process automatically.
    },

    async rollback(_context: ZelavisEdgeAdapterContext): Promise<void> {
      // Rollback leaves previous certificate files intact in baseDir/certs.
    },
  };
}
