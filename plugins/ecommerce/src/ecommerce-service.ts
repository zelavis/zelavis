import type { EcommerceApi } from "./core/types.js";
import type { ZelavisServiceDefinition } from "zelavis/service";

export type EcommerceService = ZelavisServiceDefinition<EcommerceApi> & {
  extends: "@zelavis/ecommerce";
};
