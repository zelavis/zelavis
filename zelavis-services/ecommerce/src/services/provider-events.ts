import { Effect, Schema } from "effect";
import type { ProviderEvent } from "../contracts/payment-provider.js";
import type { EcommerceApi } from "../core/types.js";
import type { BillingSubscription, Checkout, Customer, PaymentAttempt } from "../domain/entities.js";
import { InvalidWebhook, ProviderNotConfigured, UnknownProvider } from "../errors.js";

export type EventEntity = Checkout | BillingSubscription | Customer | PaymentAttempt;
export type EventKind = "checkouts" | "subscriptions" | "customers" | "paymentAttempts";
export interface EventState { checkout?: Checkout; subscription?: BillingSubscription; customer?: Customer; payment?: PaymentAttempt }
export interface EventChange { kind: EventKind; value: EventEntity; insert?: boolean }
export interface EventPlan { changes: readonly EventChange[]; payload: Checkout | BillingSubscription | PaymentAttempt }

/** Pure transition; versions and the receipt are checked by the committing repository. */
export function planProviderEvent(provider: string, event: ProviderEvent, state: EventState): EventPlan | undefined {
  const now = event.occurredAt;
  if (event.type === "checkout.completed") {
    const checkout = state.checkout;
    if (!checkout || checkout.status === "completed" || !state.customer) return undefined;
    const subscriptionId = event.subscriptionReference ? `checkout:${checkout.id}` : undefined;
    const updated = { ...checkout, status: "completed" as const, subscriptionId, updatedAt: now };
    const changes: EventChange[] = [{ kind: "checkouts", value: updated }];
    if (event.customerReference) changes.push({ kind: "customers", value: { ...state.customer, providerReferences: { ...state.customer.providerReferences, [provider]: event.customerReference }, updatedAt: now } });
    if (subscriptionId && event.subscriptionReference) {
      const line = checkout.lines[0]!;
      changes.push({ kind: "subscriptions", insert: true, value: {
        id: subscriptionId, customerId: checkout.customerId, provider, reference: event.subscriptionReference,
        amount: checkout.lines.reduce((total, item) => total + item.amount * item.quantity, 0), currency: line.currency,
        interval: line.interval ?? "month", intervalCount: line.intervalCount ?? 1,
        status: "active", cancelAtPeriodEnd: false, providerCustomerReference: event.customerReference,
        providerUpdatedAt: now, checkoutId: checkout.id, metadata: checkout.metadata, createdAt: now, updatedAt: now,
      } });
    }
    if (checkout.mode === "payment" && event.paymentReference) changes.push({ kind: "paymentAttempts", insert: true, value: {
      id: `checkout:${checkout.id}`, checkoutId: checkout.id, provider, reference: event.paymentReference,
      amount: checkout.lines.reduce((total, line) => total + line.amount * line.quantity, 0), currency: checkout.lines[0]!.currency,
      status: "captured", providerUpdatedAt: now, createdAt: now, updatedAt: now,
    } });
    return { changes, payload: updated };
  }
  if (event.type === "subscription.updated") {
    const subscription = state.subscription;
    if (!subscription || subscription.providerUpdatedAt && subscription.providerUpdatedAt >= now) return undefined;
    const updated = { ...subscription, status: event.status, cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      currentPeriodStart: event.currentPeriodStart ?? subscription.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd ?? subscription.currentPeriodEnd, providerUpdatedAt: now, updatedAt: now };
    return { changes: [{ kind: "subscriptions", value: updated }], payload: updated };
  }
  const payment = state.payment;
  if (!payment && state.subscription) {
    const created: PaymentAttempt = {
      id: `invoice:${provider}:${event.paymentReference}`, subscriptionId: state.subscription.id, provider,
      reference: event.paymentReference, amount: event.amount, currency: event.currency,
      status: event.type === "payment.succeeded" ? "captured" : "failed", providerUpdatedAt: now, createdAt: now, updatedAt: now,
    };
    return { changes: [{ kind: "paymentAttempts", insert: true, value: created }], payload: created };
  }
  if (!payment || payment.providerUpdatedAt && payment.providerUpdatedAt >= now) return undefined;
  const updated = { ...payment, status: event.type === "payment.succeeded" ? "captured" as const : "failed" as const,
    amount: event.amount, currency: event.currency, providerUpdatedAt: now, updatedAt: now };
  return { changes: [{ kind: "paymentAttempts", value: updated }], payload: updated };
}

const common = { eventId: Schema.String, occurredAt: Schema.Date };
const eventSchema = Schema.Union([
  Schema.Struct({ ...common, type: Schema.Literal("checkout.completed"), checkoutReference: Schema.String, customerReference: Schema.optional(Schema.String), subscriptionReference: Schema.optional(Schema.String), paymentReference: Schema.optional(Schema.String) }),
  Schema.Struct({ ...common, type: Schema.Literal("subscription.updated"), subscriptionReference: Schema.String, status: Schema.Literals(["pending", "active", "past_due", "cancelled", "expired", "failed"]), currentPeriodStart: Schema.optional(Schema.Date), currentPeriodEnd: Schema.optional(Schema.Date), cancelAtPeriodEnd: Schema.Boolean }),
  Schema.Struct({ ...common, type: Schema.Literals(["payment.succeeded", "payment.failed"]), paymentReference: Schema.String, amount: Schema.Number, currency: Schema.String, subscriptionReference: Schema.optional(Schema.String) }),
]);

export const receiveProviderEvents = Effect.fn("Ecommerce.receiveProviderEvents")(function* (api: EcommerceApi, providerName: string, headers: Headers, rawBody: string) {
  const provider = yield* api.payments.getProvider(providerName);
  if (!provider?.parseWebhook) return yield* new UnknownProvider({ provider: providerName });
  const events = yield* Effect.tryPromise({ try: () => provider.parseWebhook!({ headers, rawBody }), catch: cause => cause && typeof cause === "object" && "_tag" in cause && cause._tag === "ProviderNotConfigured" ? new ProviderNotConfigured({ provider: providerName }) : new InvalidWebhook({}) });
  const verified = yield* Effect.try({ try: () => {
    if (!Array.isArray(events) || events.length > 20 || !/^[a-z][a-z0-9_-]{0,31}$/.test(providerName)) throw new TypeError("Invalid events");
    return events.map(value => {
      const event = Schema.decodeUnknownSync(eventSchema)(value);
      if (!event.eventId || event.eventId.length > 128 || Number.isNaN(event.occurredAt.valueOf())) throw new TypeError("Invalid event identity");
      for (const [name, field] of Object.entries(event)) {
        if (name.endsWith("Reference") && field !== undefined && (typeof field !== "string" || !field || field.length > 200)) throw new TypeError("Invalid provider reference");
      }
      if ((event.type === "payment.succeeded" || event.type === "payment.failed") && (!Number.isSafeInteger(event.amount) || event.amount < 0 || !/^[A-Za-z]{3}$/.test(event.currency))) throw new TypeError("Invalid payment amount or currency");
      return event;
    });
  }, catch: () => new InvalidWebhook({}) });
  for (const event of verified) {
    const applied = yield* api.repositories.events.apply(providerName, event);
    if (!applied) yield* Effect.logDebug("Ecommerce provider event skipped", { provider: providerName, eventId: event.eventId });
  }
  return { received: verified.length };
});
