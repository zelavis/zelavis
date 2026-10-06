import { Effect } from "effect";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import type {
  ZelavisEdgeAdapter,
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
    execute: (operationId, args) => present(Effect.gen(function* () {
      const record = yield* integration(() => options.broker.submit({ operation: operationId, arguments: args }, principal));
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const summary = yield* integration(() => options.agent.getHostOperation(record.operationId));
        if (summary && (summary.status === "succeeded" || summary.status === "failed")) {
          yield* evaluate(() => { if (summary.status === "failed") throw new Error(summary.error?.message ?? `Host operation "${operationId}" failed.`); });
          return (summary.result ?? {}) as Record<string, unknown>;
        }
        yield* Effect.sleep(pollIntervalMs);
      }
      return yield* evaluate(() => { throw new Error(`Host operation "${operationId}" timed out.`); });
    })),
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

    detect: () => present(Effect.gen(function* () {
      const result = yield* Effect.result(integration(() => invoker.execute("zelavis.edge-unit-control", { action: "status", unit: unitName })));
      if (result._tag === "Failure") return { state: "unavailable" as const, installed: false, healthy: false,
        checkedAt: new Date().toISOString(), detail: result.failure.message };
      const active = Boolean(result.success.active), status = String(result.success.status ?? "unknown");
      return { state: status !== "not_installed" && (active || status === "inactive" || status === "success") ? "available" as const : "unavailable" as const,
        installed: status !== "not_installed", healthy: active || status === "inactive" || status === "success",
        checkedAt: new Date().toISOString(), version: "3.7.13", detail: status };
    })),

    stage: context => present(Effect.gen(function* () {
      const pub = context.publication;
      let compiled: ZelavisEdgeCompiledPublication | undefined;
      if ("routes" in pub && Array.isArray((pub as unknown as ZelavisEdgeCompiledPublication).routes)) compiled = pub as unknown as ZelavisEdgeCompiledPublication;
      else if (routeStore) compiled = yield* integration(() => routeStore.getPublication(Number(pub.revision.replace(/^rev-/, ""))));
      if (!compiled) {
        yield* evaluate(() => { if (pub.routeCount !== 0) throw new Error("The exact Edge publication is unavailable."); });
        compiled = { schemaVersion: 1, revision: Number(pub.revision.replace(/^rev-/, "")) || 1,
          compiledAt: new Date().toISOString(), hostnames: [], routes: [], requiredCapabilities: pub.requiredCapabilities ?? [],
          certificateRefs: pub.certificateRefs ?? [], routeCount: 0 };
      }
      const generation = yield* evaluate(() => compileTraefikPublication(compiled!, { generation: pub.revision, certificateDirectory: `${baseDir}/certs` }));
      yield* integration(() => invoker.execute("zelavis.edge-stage", { generation: pub.revision, "base-dir": baseDir,
        "config-json": generation.files["traefik-dynamic.json"]!, "manifest-json": generation.files["manifest.json"]! }));
    })),

    verify: context => present(Effect.gen(function* () {
      const result = yield* Effect.result(integration(() => invoker.execute("zelavis.edge-validate", { generation: context.publication.revision, "base-dir": baseDir })));
      if (result._tag === "Failure") return { ready: false, detail: result.failure.message };
      return result.success.valid ? { ready: true } : { ready: false, detail: String(result.success.error ?? "Offline validation failed") };
    })),

    activate: context => present(Effect.gen(function* () {
      const result = yield* integration(() => invoker.execute("zelavis.edge-activate", { generation: context.publication.revision, "base-dir": baseDir }));
      yield* evaluate(() => { if (result.status !== "activated") throw new Error(`Failed to activate generation ${context.publication.revision}: ${result.error ?? "unknown error"}`); });
      // The file provider watches atomic publications. Starting an active unit
      // is idempotent; a reload/restart would interrupt existing connections.
      yield* integration(() => invoker.execute("zelavis.edge-unit-control", { action: "start", unit: unitName }));
    })),

    drain: context => present(integration(() => invoker.execute("zelavis.edge-drain", { "duration-ms": String(drainDurationMs),
      ...(context.previousAdapterId ? { "previous-adapter": context.previousAdapterId } : {}) })).pipe(Effect.asVoid)),

    rollback: () => present(Effect.gen(function* () {
      yield* integration(() => invoker.execute("zelavis.edge-rollback", { "base-dir": baseDir }));
      yield* integration(() => invoker.execute("zelavis.edge-unit-control", { action: "start", unit: unitName }));
    })),
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
    stage: context => present(Effect.gen(function* () {
      if (!certificateResolver || context.publication.certificateRefs.length === 0) return;
      for (const ref of context.publication.certificateRefs) {
        const cert = yield* integration(() => certificateResolver(ref));
        if (!cert) return yield* evaluate(() => { throw new Error(`Certificate ${ref} is unavailable.`); });
        yield* integration(() => invoker.execute("zelavis.edge-stage", { generation: context.publication.revision, "base-dir": baseDir,
          "cert-name": ref.replace(/[^a-zA-Z0-9_-]/g, "_"), "cert-pem": cert.certPem, "key-pem": cert.keyPem }));
      }
    })),
    activate: () => present(Effect.void),
    rollback: () => present(Effect.void),
  };
}
