import { loadPluginPackage } from "../../../packages/zelavis/dist/service.js";
import { resolveLocalPackageManifest } from "../../../packages/zelavis/dist/adapters/_local-runtime.js";

export const hostingDirectory = new URL("..", import.meta.url).pathname;
export const hostingManifest = resolveLocalPackageManifest(hostingDirectory);
export function loadHostingPlugin() {
  return loadPluginPackage({ manifest: hostingManifest, importer: () => import("../dist/index.js") });
}
