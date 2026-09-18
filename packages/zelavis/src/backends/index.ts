export * from "./registry.js";
export * from "./host.js";
export * from "./native/index.js";
export * from "./docker/index.js";

import { createDockerDeploymentBackend } from "./docker/index.js";
import { createNativeDeploymentBackend } from "./native/index.js";
import type { ZelavisBackendHostProbes } from "./host.js";
import type { ZelavisDeploymentBackendAdapter } from "./registry.js";
import type { ZelavisProjectRuntimeDriver } from "../project.js";

/**
 * The built-in backend adapter set. The runtime adapter supplies the host
 * probes, so this module stays free of runtime-specific imports.
 */
export function createBuiltinDeploymentBackends(options: {
  readonly host: ZelavisBackendHostProbes;
  readonly nativeProjectRuntime?: ZelavisProjectRuntimeDriver;
}): readonly ZelavisDeploymentBackendAdapter[] {
  return Object.freeze([
    createNativeDeploymentBackend({
      host: options.host,
      projectRuntime: options.nativeProjectRuntime,
    }),
    createDockerDeploymentBackend({ host: options.host }),
  ]);
}
