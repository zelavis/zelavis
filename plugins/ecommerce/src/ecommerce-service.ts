import type { EcommerceApi } from "./core/types.js";

export interface EcommerceService {
  name: string;
  register(api: EcommerceApi): void | Promise<void>;
}
