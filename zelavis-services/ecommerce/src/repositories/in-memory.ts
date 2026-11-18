import { memoryFulfillment } from "./memory-fulfillment.js";
import { memoryEvents } from "./memory-events.js";
/**
 * Repositories backed by a Map, for tests and for running without a database.
 *
 * This was six classes of identical CRUD differing only in their entity and
 * which field was the key. With the contract generic, it is one factory told
 * how to find a value's key — the repetition was the only reason the six could
 * drift apart.
 */
import { Effect } from "effect";
import { StorageFailure } from "../errors.js";
import type { EcommerceRepositories, Repository } from "../contracts/repositories.js";
import type {
  BillingSubscription,
  Checkout,
  Coupon,
  Customer,
  Order,
  PaymentAttempt,
  Product,
} from "../domain/entities.js";

/**
 * A repository over a Map.
 *
 * Nothing here can fail, so every operation is `Effect.succeed`: the error
 * channel still says `StorageFailure` because that is what the contract
 * promises callers, and an in-memory implementation simply never uses it.
 */
function inMemoryRepository<A>(keyOf: (value: A) => string): Repository<A> & {
  readonly findByKey: (key: string) => Effect.Effect<A | undefined, never>;
} {
  const items = new Map<string, A>();
  const put = (value: A) =>
    Effect.sync(() => {
      items.set(keyOf(value), value);
      return value;
    });
  const get = (key: string) => Effect.sync(() => items.get(key));
  return {
    create: put,
    update: put,
    findById: get,
    findByKey: get,
    list: () => Effect.sync(() => [...items.values()]),
  };
}

export function createInMemoryEcommerceRepositories(
  /** Repositories a caller supplies instead; the rest are in memory. */
  overrides: Partial<EcommerceRepositories> = {},
): EcommerceRepositories {
  const coupons = inMemoryRepository<Coupon>((coupon) => coupon.code);
  const outbox = memoryFulfillment();
  const customers = inMemoryRepository<Customer>(customer => customer.id);
  const customerRepository = {
    ...customers,
    setProviderReference: (id: string, provider: string, reference: string, at: Date) => Effect.uninterruptible(Effect.gen(function* () {
      const existing = yield* customers.findById(id);
      if (!existing) return yield* new StorageFailure({ operation: "setProviderReference", cause: "Customer is missing" });
      return yield* customers.update({ ...existing, providerReferences: { ...existing.providerReferences, [provider]: reference }, updatedAt: at });
    })),
  };
  const repositories = {
    fulfillment: outbox.repository,
    checkouts: inMemoryRepository<Checkout>((checkout) => checkout.id),
    customers: customerRepository,
    products: inMemoryRepository<Product>((product) => product.id),
    orders: inMemoryRepository<Order>((order) => order.id),
    paymentAttempts: inMemoryRepository<PaymentAttempt>((attempt) => attempt.id),
    subscriptions: inMemoryRepository<BillingSubscription>((subscription) => subscription.id),
    // A coupon is addressed by its code, so it exposes that name instead.
    coupons: {
      create: coupons.create,
      update: coupons.update,
      list: coupons.list,
      findByCode: coupons.findByKey,
    },
    ...overrides,
  };
  const customBilling = ["customers", "checkouts", "paymentAttempts", "subscriptions", "fulfillment"].some(name => Object.hasOwn(overrides, name));
  const events = overrides.events ?? (customBilling ? {
    apply: () => Effect.fail(new StorageFailure({ operation: "applyProviderEvent", cause: "Custom billing repositories require an atomic events repository and matching outbox" })),
  } : memoryEvents(repositories, outbox.emit));
  return { ...repositories, events };
}
