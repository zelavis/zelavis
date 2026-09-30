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
import type { EcommerceApi } from "./types.js";

export interface CreateEcommerceOptions {
  config?: Record<string, unknown>;
  services?: readonly EcommerceService[];
  repositories?: Partial<EcommerceRepositories>;
}

export async function createEcommerce(options: CreateEcommerceOptions = {}): Promise<EcommerceApi> {
  const repositories = createInMemoryEcommerceRepositories(options.repositories);

  // Every domain service needs storage and nothing else, so one layer provides
  // it to all five rather than each building its own.
  const layer = Layer.mergeAll(
    Customers.layer,
    Coupons.layer,
    Products.layer,
    Orders.layer,
    Payments.layer,
  ).pipe(Layer.provide(Repositories.layerOf(repositories)));

  const runtime = ManagedRuntime.make(layer);
  const [customers, coupons, products, orders, payments] = await runtime.runPromise(
    Effect.all([Customers, Coupons, Products, Orders, Payments]),
  );

  const api: EcommerceApi = {
    context: {
      config: options.config ?? {},
      providers: Object.freeze([...(options.services ?? [])]),
    },
    repositories,
    customers,
    coupons,
    products,
    orders,
    payments,
    runPromise: (effect) => runtime.runPromise(effect),
  };

  for (const service of options.services ?? []) {
    await service.register(api);
  }

  return api;
}
