import { Effect } from "effect";
import { IntegrationFailure, evaluate, integrationValue, present, unwrapFailure } from "../../core/runtime/effect-boundary.js";
import type { ZelavisBackendHostProbes } from "../host.js";
import type {
  ZelavisDeploymentBackendAdapter,
  ZelavisDeploymentBackendDetection,
} from "../registry.js";

function detectDockerBackend(
  host: ZelavisBackendHostProbes,
): Promise<ZelavisDeploymentBackendDetection> {
  return present(Effect.gen(function* (): Effect.fn.Return<ZelavisDeploymentBackendDetection, IntegrationFailure> {
  const checkedAt = new Date().toISOString();
  const result = yield* integrationValue(host.runProbeCommand("docker", [
    "version",
    "--format",
    "{{json .}}",
  ]));
  if (result.missing) {
    return {
      state: "unavailable",
      installed: false,
      healthy: false,
      checkedAt,
      error: "Docker CLI was not found.",
    };
  }
  if (result.timedOut) {
    return {
      state: "degraded",
      installed: true,
      healthy: false,
      checkedAt,
      error: "Docker capability detection timed out.",
    };
  }
  if (result.code !== 0) {
    return {
      state: "degraded",
      installed: true,
      healthy: false,
      checkedAt,
      error: result.stderr.trim().slice(0, 1_000) || "Docker Engine is not reachable.",
    };
  }
  return yield* Effect.gen(function* (): Effect.fn.Return<ZelavisDeploymentBackendDetection, IntegrationFailure> {
    const value = yield* evaluate(() => JSON.parse(result.stdout) as {
      Server?: { Version?: unknown; ApiVersion?: unknown; Os?: unknown; Arch?: unknown };
    });
    if (!value.Server || typeof value.Server.Version !== "string") {
      return yield* Effect.fail(new IntegrationFailure(new Error("Docker did not report a server version.")));
    }
    const info = yield* integrationValue(host.runProbeCommand("docker", [
      "info",
      "--format",
      "{{json .SecurityOptions}}",
    ]));
    const securityOptions = info.code === 0
      ? yield* evaluate(() => JSON.parse(info.stdout) as unknown)
      : [];
    const rootless = Array.isArray(securityOptions) &&
      securityOptions.some((option) => String(option).includes("rootless"));
    return {
      state: "ready",
      installed: true,
      healthy: true,
      version: value.Server.Version,
      ...(typeof value.Server.ApiVersion === "string"
        ? { apiVersion: value.Server.ApiVersion }
        : {}),
      rootless,
      checkedAt,
      details: {
        os: typeof value.Server.Os === "string" ? value.Server.Os : "unknown",
        arch: typeof value.Server.Arch === "string" ? value.Server.Arch : "unknown",
      },
    };
  }).pipe(Effect.catch((failure) => {
    const error = unwrapFailure(failure);
    return Effect.succeed({
      state: "degraded" as const,
      installed: true,
      healthy: false,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }));
  }));
}

/** Built-in read-only Docker adapter. It advertises no Project driver yet. */
export function createDockerDeploymentBackend(options: {
  readonly host: ZelavisBackendHostProbes;
}): ZelavisDeploymentBackendAdapter {
  return Object.freeze({
    id: "docker",
    title: "Docker",
    capabilities: Object.freeze({
      isolationBoundary: "os-container" as const,
      filesystemIsolation: "available" as const,
      processIsolation: "available" as const,
      networkIsolation: "available" as const,
      resourceControls: Object.freeze({
        cpu: "available" as const,
        memory: "available" as const,
        pids: "available" as const,
        disk: "planned" as const,
      }),
      exec: "available" as const,
      persistentStorage: "available" as const,
      snapshots: "planned" as const,
      images: "available" as const,
      description:
        "Docker is detected read-only as optional host infrastructure. Zelavis does not yet register a Docker Project driver or grant the Platform access to the Docker control socket.",
    }),
    detect: () => detectDockerBackend(options.host),
  });
}
