import type { EcommerceApi } from "./core/types.js";
import type { ZelavisPluginDefinition } from "zelavis/plugin";

export type EcommercePluginExtensionPoint = "payments";

export type EcommercePlugin = ZelavisPluginDefinition<EcommerceApi> & {
  extends: {
    plugin: "zelavis-ecommerce";
    extensionPoint: EcommercePluginExtensionPoint;
  };
};
