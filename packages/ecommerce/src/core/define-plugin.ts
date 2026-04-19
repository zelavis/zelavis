import type { EcommerceApi } from "./types.js";

export interface EcommercePlugin {
  name: string;
  setup(api: EcommerceApi): void | Promise<void>;
}

export function definePlugin(plugin: EcommercePlugin): Readonly<EcommercePlugin> {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError("A plugin definition object is required.");
  }

  if (!plugin.name || typeof plugin.name !== "string") {
    throw new TypeError("A plugin must include a string name.");
  }

  if (typeof plugin.setup !== "function") {
    throw new TypeError("A plugin must expose a setup(api) function.");
  }

  return Object.freeze({ ...plugin });
}
