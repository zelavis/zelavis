import type { AuthApi } from "./types.js";

export interface AuthPlugin {
  name: string;
  setup(api: AuthApi): void | Promise<void>;
}

export function defineAuthPlugin(plugin: AuthPlugin): Readonly<AuthPlugin> {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError("An auth plugin definition object is required.");
  }

  if (!plugin.name || typeof plugin.name !== "string") {
    throw new TypeError("An auth plugin must include a string name.");
  }

  if (typeof plugin.setup !== "function") {
    throw new TypeError("An auth plugin must expose a setup(api) function.");
  }

  return Object.freeze({ ...plugin });
}
