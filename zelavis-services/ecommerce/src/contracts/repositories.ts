/**
 * Storage boundaries, in the error channel.
 *
 * These returned bare Promises, so a storage failure arrived as a rejection
 * indistinguishable from a bug and a missing row arrived as `null` that
 * nothing forced a caller to consider. Each operation now says it can fail
 * with `StorageFailure`, and a lookup that finds nothing says so in its type.
 *
 * `| undefined` rather than `Option`, to match `zelavis/db`'s own repository
 * surface: two conventions for absence in one codebase is worse than either.
 */
import type { Effect } from "effect";
import type {
  BillingSubscription,
  Coupon,
  Customer,
  Order,
  PaymentAttempt,
  Product,
} from "../domain/entities.js";
import type { StorageFailure } from "../errors.js";

/**
 * The shape every repository here shares.
 *
 * Written once because all six were identical but for their entity, and six
 * copies of the same four signatures drift one method at a time.
 */
export interface Repository<A, Key extends string = string> {
  readonly create: (value: A) => Effect.Effect<A, StorageFailure>;
  readonly findById: (id: Key) => Effect.Effect<A | undefined, StorageFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<A>, StorageFailure>;
  readonly update: (value: A) => Effect.Effect<A, StorageFailure>;
}

export type CustomerRepository = Repository<Customer>;
export type ProductRepository = Repository<Product>;
export type OrderRepository = Repository<Order>;
export type PaymentAttemptRepository = Repository<PaymentAttempt>;
export type SubscriptionRepository = Repository<BillingSubscription>;

/** A coupon is addressed by its code, which is its identity rather than an id. */
export interface CouponRepository extends Omit<Repository<Coupon>, "findById"> {
  readonly findByCode: (code: string) => Effect.Effect<Coupon | undefined, StorageFailure>;
}

export interface EcommerceRepositories {
  readonly customers: CustomerRepository;
  readonly coupons: CouponRepository;
  readonly products: ProductRepository;
  readonly orders: OrderRepository;
  readonly paymentAttempts: PaymentAttemptRepository;
  readonly subscriptions: SubscriptionRepository;
}
