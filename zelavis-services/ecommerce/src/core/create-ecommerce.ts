import { createFulfillment } from "../services/fulfillment.js";
/**
 * Builds the ecommerce API.
 *
 * The services are Effect services now, so this composes their layers and
 * builds one runtime rather than calling five constructors. A caller outside
 * Effect uses `runPromise`; a caller inside Effect can yield the services'
 * effects directly.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import type { EcommerceRepositories } from "../contracts/repositories.js";
import { createInMemoryEcommerceRepositories } from "../repositories/in-memory.js";
import { Coupons } from "../services/coupons.js";
import { Customers } from "../services/customers.js";
import { Orders } from "../services/orders.js";
import { Payments } from "../services/payments.js";
import { Products } from "../services/products.js";
import { Repositories } from "../services/repositories.js";
import type { EcommerceService } from "../ecommerce-service.js";
import { Checkouts } from "../services/checkouts.js";
import type { EcommerceApi } from "./types.js";

export interface CreateEcommerceOptions {
  config?: Record<string, unknown>;
  services?: readonly EcommerceService[];
  repositories?: Partial<EcommerceRepositories>;
  now?: () => number;
  runtimeScope?: object;
}

export function createEcommerce(options: CreateEcommerceOptions = {}): Promise<EcommerceApi> {
  return Effect.runPromise(Effect.gen(function* () {
    const repositories = createInMemoryEcommerceRepositories(options.repositories);

    // Every domain service needs storage and nothing else, so one layer provides
    // it to all five rather than each building its own.
    const base = Layer.mergeAll(
      Customers.layer,
      Coupons.layer,
      Products.layer,
      Orders.layer,
      Payments.layer,
    ).pipe(Layer.provide(Repositories.layerOf(repositories)));

    const layer = Layer.merge(base, Checkouts.layer.pipe(Layer.provide(base), Layer.provide(Repositories.layerOf(repositories))));
    const runtime = ManagedRuntime.make(layer);
    const [customers, coupons, products, orders, payments, checkouts] = yield* Effect.tryPromise(() => runtime.runPromise(
      Effect.all([Customers, Coupons, Products, Orders, Payments, Checkouts]),
    ));

    const api: EcommerceApi = {
      context: {
        config: options.config ?? {},
        runtimeScope: options.runtimeScope,
        providers: Object.freeze([...(options.services ?? [])]),
      },
      repositories,
      customers: { ...customers, portal: checkouts.portal },
      checkouts,
      fulfillment: createFulfillment(repositories.fulfillment, options.now),
      coupons,
      products,
      orders,
      payments,
      runPromise: (effect) => runtime.runPromise(effect),
    };

    for (const service of options.services ?? []) {
      yield* Effect.tryPromise(() => Promise.resolve(service.register(api)));
    }

    return api;
  }));
}
