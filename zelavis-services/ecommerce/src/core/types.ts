import type { EcommerceRepositories } from "../contracts/repositories.js";
import type { Coupons } from "../services/coupons.js";
import type { Customers } from "../services/customers.js";
import type { Orders } from "../services/orders.js";
import type { Payments } from "../services/payments.js";
import type { Products } from "../services/products.js";
import type { EcommerceService } from "../ecommerce-service.js";

export interface EcommerceContext {
  config: Record<string, unknown>;
  /** Opaque runtime identity for providers whose setup owns per-runtime credentials. */
  runtimeScope?: object;
  providers: readonly EcommerceService[];
}

/**
 * What a caller gets back from `createEcommerce`.
 *
 * Each field is the service's interface rather than a class instance, so a
 * caller holds Effects it decides when to run. The runtime that runs them is
 * built once here and carried on `runPromise`, which is the only place this
 * package crosses back into Promises.
 */
export interface EcommerceApi {
  context: EcommerceContext;
  repositories: EcommerceRepositories;
  customers: Customers["Service"] & { portal: import("../services/checkouts.js").Checkouts["Service"]["portal"] };
  fulfillment: import("../services/fulfillment.js").FulfillmentApi;
  checkouts: import("../services/checkouts.js").Checkouts["Service"];
  coupons: Coupons["Service"];
  products: Products["Service"];
  orders: Orders["Service"];
  payments: Payments["Service"];
  /** Runs one of this API's Effects, for callers that are not themselves Effects. */
  runPromise<A, E>(effect: import("effect").Effect.Effect<A, E>): Promise<A>;
}
