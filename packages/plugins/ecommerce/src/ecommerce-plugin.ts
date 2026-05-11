import type { EcommerceApi } from "./core/types.js";

export const ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1 =
  "ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1" as const;
export type EcommerceChildPluginContractVersion =
  typeof ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1;
export type EcommercePluginExtensionPoint = "payments";

export interface EcommercePlugin {
  name: string;
  contractVersion?: EcommerceChildPluginContractVersion;
  childPlugin?: true;
  targetPlugin?: "zelavis-ecommerce";
  extensionPoint: EcommercePluginExtensionPoint;
  setup(api: EcommerceApi): void | Promise<void>;
}

export function defineEcommercePlugin(plugin: EcommercePlugin): Readonly<EcommercePlugin> {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError("A plugin definition object is required.");
  }

  if (!plugin.name || typeof plugin.name !== "string") {
    throw new TypeError("A plugin must include a string name.");
  }

  if (
    "contractVersion" in plugin &&
    plugin.contractVersion !== undefined &&
    plugin.contractVersion !== ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1
  ) {
    throw new TypeError(
      `Unsupported ecommerce child plugin contract version. Expected ${ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1}.`,
    );
  }

  if (plugin.extensionPoint !== "payments") {
    throw new TypeError(
      'Ecommerce child plugins must target a supported extension point such as "payments".',
    );
  }

  if (
    "targetPlugin" in plugin &&
    plugin.targetPlugin !== undefined &&
    plugin.targetPlugin !== "zelavis-ecommerce"
  ) {
    throw new TypeError(
      'Ecommerce child plugins must target "zelavis-ecommerce".',
    );
  }

  if (typeof plugin.setup !== "function") {
    throw new TypeError("A plugin must expose a setup(api) function.");
  }

  return Object.freeze({
    ...plugin,
    contractVersion: ZELAVIS_ECOMMERCE_CHILD_PLUGIN_V1,
    childPlugin: true,
    targetPlugin: "zelavis-ecommerce",
  });
}
