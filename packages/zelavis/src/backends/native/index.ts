import type { ZelavisBackendHostProbes } from "../host.js";
import type {
  ZelavisDeploymentBackendAdapter,
  ZelavisDeploymentBackendDetection,
} from "../registry.js";
import type { ZelavisProjectRuntimeDriver } from "../../project.js";

async function detectNativeBackend(
  host: ZelavisBackendHostProbes,
): Promise<ZelavisDeploymentBackendDetection> {
  const linux = host.platform === "linux";
  const [cgroupV2, systemd, userNamespaces] = linux
    ? await Promise.all([
        host.pathExists("/sys/fs/cgroup/cgroup.controllers"),
        host.pathExists("/run/systemd/system"),
        host.readTextFile("/proc/sys/user/max_user_namespaces")
          .then((value) => Number.parseInt(value?.trim() ?? "", 10) > 0),
      ])
    : [false, false, false];
  return {
    state: "ready",
    installed: true,
    healthy: true,
    checkedAt: new Date().toISOString(),
    details: {
      platform: host.platform,
      cgroupV2,
      systemd,
      userNamespaces,
      isolationProfile: "legacy-process",
    },
  };
}

/** Built-in native backend adapter. Execution remains on the local Project driver. */
export function createNativeDeploymentBackend(options: {
  readonly host: ZelavisBackendHostProbes;
  readonly projectRuntime?: ZelavisProjectRuntimeDriver;
}): ZelavisDeploymentBackendAdapter {
  return Object.freeze({
    id: "native",
    title: "Zelavis Native",
    ...(options.projectRuntime ? { projectRuntime: options.projectRuntime } : {}),
    capabilities: Object.freeze({
      isolationBoundary: "process" as const,
      filesystemIsolation: "planned" as const,
      processIsolation: "planned" as const,
      networkIsolation: "planned" as const,
      resourceControls: Object.freeze({
        cpu: "planned" as const,
        memory: "planned" as const,
        pids: "planned" as const,
        disk: "planned" as const,
      }),
      exec: "available" as const,
      persistentStorage: "available" as const,
      snapshots: "planned" as const,
      images: "unavailable" as const,
      description:
        "Current native execution is operational isolation for trusted code. Per-Project identities, namespaces, filesystem views, cgroup limits, and policy confinement are planned and are not claimed yet.",
    }),
    detect: () => detectNativeBackend(options.host),
  });
}
