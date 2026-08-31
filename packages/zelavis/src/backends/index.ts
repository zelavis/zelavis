export * from "./registry.js";
export * from "./native/index.js";
export * from "./docker/index.js";

import { createDockerDeploymentBackend } from "./docker/index.js";
import { createNativeDeploymentBackend } from "./native/index.js";
import type { ZelavisDeploymentBackendAdapter } from "./registry.js";
import type { ZelavisProjectRuntimeDriver } from "../project.js";

/** The built-in backend adapter set supplied by the Node Platform adapter. */
export function createBuiltinDeploymentBackends(options: {
  readonly nativeProjectRuntime?: ZelavisProjectRuntimeDriver;
} = {}): readonly ZelavisDeploymentBackendAdapter[] {
  return Object.freeze([
    createNativeDeploymentBackend({ projectRuntime: options.nativeProjectRuntime }),
    createDockerDeploymentBackend(),
  ]);
}
