/**
 * Payments and recurring subscriptions.
 *
 * Providers stay Promise-returning on purpose. `PaymentProvider` is a port to
 * third-party SDKs — Stripe's and PayPal's are Promises — so it is wrapped at
 * the boundary with `Effect.tryPromise` rather than pushed into every adapter.
 * That keeps a provider's rejection in the error channel as `ProviderFailure`,
 * where before it escaped as whatever the SDK happened to throw.
 *
 * Lifecycle notes for subscriptions are unchanged and live on the contract:
 * pending → active → past_due → cancelled | expired | failed, with renewals
 * arriving as webhooks that create a further PaymentAttempt.
 */
import { Context, Effect, Layer } from "effect";
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  PaymentProvider,
} from "../contracts/payment-provider.js";
import type { BillingSubscription, Order, PaymentAttempt } from "../domain/entities.js";
import {
  InvalidInput,
  NotFound,
  ProviderFailure,
  type StorageFailure,
  UnknownProvider,
  UnsupportedOperation,
} from "../errors.js";
import { Repositories } from "./repositories.js";

export interface CancelSubscriptionOptions {
  providerName?: string;
  metadata?: Record<string, unknown>;
}

export class Payments extends Context.Service<Payments, {
  registerProvider(name: string, provider: PaymentProvider): Effect.Effect<PaymentProvider, InvalidInput>;
  getProvider(name: string): Effect.Effect<PaymentProvider | undefined>;
  listProviders(): Effect.Effect<ReadonlyArray<string>>;
  createPayment(
    order: Order,
    providerName: string,
  ): Effect.Effect<PaymentAttempt, UnknownProvider | ProviderFailure | StorageFailure>;
  listPaymentAttempts(): Effect.Effect<ReadonlyArray<PaymentAttempt>, StorageFailure>;
  createSubscription(
    input: CreateSubscriptionInput,
    providerName: string,
  ): Effect.Effect<BillingSubscription, UnsupportedOperation | ProviderFailure | StorageFailure>;
  getSubscriptionById(id: string): Effect.Effect<BillingSubscription | undefined, StorageFailure>;
  listSubscriptions(): Effect.Effect<ReadonlyArray<BillingSubscription>, StorageFailure>;
  cancelSubscription(
    subscriptionId: string,
    options?: CancelSubscriptionOptions,
  ): Effect.Effect<
    BillingSubscription,
    NotFound | UnsupportedOperation | ProviderFailure | StorageFailure
  >;
}>()("zelavis/ecommerce/Payments") {
  static readonly layer = Layer.effect(
    Payments,
    Effect.gen(function* () {
      const { paymentAttempts, subscriptions } = yield* Repositories;
      const providers = new Map<string, PaymentProvider>();

      /** One place where a provider's Promise becomes a typed failure. */
      const callProvider = <A>(
        provider: string,
        operation: string,
        run: () => Promise<A>,
      ): Effect.Effect<A, ProviderFailure> =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new ProviderFailure({ provider, operation, cause }),
        });

      const registerProvider = Effect.fn("Payments.registerProvider")(
        function* (name: string, provider: PaymentProvider) {
          if (!name) {
            return yield* new InvalidInput({
              field: "name",
              message: "Payment provider registration requires a string name.",
            });
          }
          providers.set(name, provider);
          return provider;
        },
      );

      const createPayment = Effect.fn("Payments.createPayment")(
        function* (order: Order, providerName: string) {
          const provider = providers.get(providerName);
          if (!provider) return yield* new UnknownProvider({ provider: providerName });
          const attempt = yield* callProvider(providerName, "createPayment", () =>
            provider.createPayment({
              order,
              amount: order.totals.grandTotal,
              currency: order.totals.currency,
            }));
          return yield* paymentAttempts.create(attempt);
        },
      );

      const createSubscription = Effect.fn("Payments.createSubscription")(
        function* (input: CreateSubscriptionInput, providerName: string) {
          const provider = providers.get(providerName);
          if (!provider?.createSubscription) {
            return yield* new UnsupportedOperation({
              provider: providerName,
              operation: "createSubscription",
            });
          }
          const created = yield* callProvider(providerName, "createSubscription", () =>
            provider.createSubscription!({ ...input, intervalCount: input.intervalCount ?? 1 }));
          return yield* subscriptions.create(created);
        },
      );

      const cancelSubscription = Effect.fn("Payments.cancelSubscription")(
        function* (subscriptionId: string, options: CancelSubscriptionOptions = {}) {
          const existing = yield* subscriptions.findById(subscriptionId);
          if (!existing) {
            return yield* new NotFound({ resource: "subscription", id: subscriptionId });
          }
          const providerName = options.providerName ?? existing.provider;
          const provider = providers.get(providerName);
          if (!provider?.cancelSubscription) {
            return yield* new UnsupportedOperation({
              provider: providerName,
              operation: "cancelSubscription",
            });
          }
          const updated = yield* callProvider(providerName, "cancelSubscription", () =>
            provider.cancelSubscription!({
              subscription: existing,
              metadata: options.metadata,
            } satisfies CancelSubscriptionInput));
          return yield* subscriptions.update(updated);
        },
      );

      return Payments.of({
        registerProvider,
        getProvider: (name) => Effect.sync(() => providers.get(name)),
        listProviders: () => Effect.sync(() => [...providers.keys()]),
        createPayment,
        listPaymentAttempts: () => paymentAttempts.list(),
        createSubscription,
        getSubscriptionById: (id) => subscriptions.findById(id),
        listSubscriptions: () => subscriptions.list(),
        cancelSubscription,
      });
    }),
  );
}
