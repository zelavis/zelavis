import { Effect, Schema, Semaphore } from "effect";
import type { EcommerceApi } from "@zelavis/ecommerce";
import { accountAccess, human } from "./accounts.js";
import { maximumProjects, PlanId, type hostingPlans } from "./plans.js";
import { dateString, dbCall, decode, hostingError, invalid, ok, revisionConflict, route, strict, subscriptionCollection, table, type Commerce, type HostingStore, type Transaction } from "./runtime.js";
import type { hostingSettings } from "./settings.js";

type Message = Parameters<Parameters<EcommerceApi["fulfillment"]["registerHandler"]>[1]>[0];
type Billing = NonNullable<Effect.Success<ReturnType<EcommerceApi["repositories"]["subscriptions"]["findById"]>>>;

const identity = Schema.String.check(Schema.isBetweenLength(1, 200));
const projectId = Schema.String.check(Schema.isPattern(/^h-[a-z2-7]{12}$/u));
const state = Schema.Literals(["pending", "active", "past_due", "suspended"]);
const record = Schema.Struct({
  principalId: identity, planId: PlanId, state,
  ecommerceCustomerId: identity, ecommerceSubscriptionId: Schema.optional(identity),
  checkoutId: Schema.optional(identity), checkoutAttempt: identity, provider: identity,
  currentPeriodEnd: Schema.optional(dateString), graceEndsAt: Schema.optional(dateString),
  activeConfirmedAt: Schema.optional(dateString), lapseGraceDays: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
  cancelAtPeriodEnd: Schema.optional(Schema.Boolean), providerStatus: Schema.optional(Schema.String),
  billedProjects: Schema.Array(projectId).check(Schema.isMaxLength(maximumProjects), Schema.isUnique()),
  reserved: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumProjects })),
  providerUpdatedAt: Schema.optional(dateString), lastMessageId: Schema.optional(identity),
  reviewAfter: Schema.optional(dateString),
  entitlementsPending: Schema.optional(Schema.Boolean),
  updatedAt: dateString,
}).check(Schema.makeFilter(value => value.billedProjects.length + value.reserved <= maximumProjects));
export type HostingSubscription = Omit<typeof record.Type, "checkoutId" | "checkoutAttempt" | "provider" | "providerStatus" | "reviewAfter" | "entitlementsPending" | "activeConfirmedAt" | "lapseGraceDays">;
export type Subscription = typeof record.Type;
const readSubscription = Schema.decodeUnknownSync(Schema.Struct({ ...record.fields, allocatedProjects: Schema.Natural }));
const subscriptions = table(subscriptionCollection, raw => {
  const { allocatedProjects, ...subscription } = readSubscription(raw);
  if (allocatedProjects > maximumProjects || allocatedProjects !== subscription.billedProjects.length + subscription.reserved) {
    throw new TypeError("Invalid Hosting Project allocation.");
  }
  return subscription;
});
const readCheckoutInput = Schema.decodeUnknownSync(Schema.Struct({ planId: PlanId }), strict);
const readMessage = Schema.decodeUnknownSync(Schema.Struct({
  id: identity, subscriptionId: Schema.optional(identity), status: Schema.optional(Schema.String), metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}));
const dayMs = 86_400_000;

export const inactive = () => hostingError(402, "subscription_inactive", "An active hosting subscription is required.");
const subscriptionMissing = () => hostingError(404, "hosting_subscription_not_found", "No hosting subscription was found.");
const paymentFailure = () => hostingError(502, "hosting_billing_unavailable", "Ecommerce could not complete the billing operation.");
const checkoutPending = () => hostingError(409, "hosting_checkout_pending", "A checkout is already pending for this account.");
const publicSubscription = ({
  checkoutId: _id, checkoutAttempt: _attempt, provider: _provider, providerStatus: _status,
  reviewAfter: _review, entitlementsPending: _pending, activeConfirmedAt: _active, lapseGraceDays: _days, ...view
}: Subscription): HostingSubscription => view;
const timestamp = (now: () => number) => new Date(now()).toISOString();

const isLapse = (status: string | undefined) => status === "past_due" || status === "failed";

function nextState(current: Subscription, billing: Billing, now: number): Subscription["state"] {
  if (billing.status === "active") {
    if (billing.cancelAtPeriodEnd && billing.currentPeriodEnd && billing.currentPeriodEnd.valueOf() <= now) return "suspended";
    return "active";
  }
  if (isLapse(billing.status)) return current.state === "suspended" ? "suspended" : "past_due";
  if (billing.status === "cancelled" || billing.status === "expired") {
    if (current.state === "suspended" || !billing.currentPeriodEnd || billing.currentPeriodEnd.valueOf() <= now) return "suspended";
  }
  return current.state;
}

export function accessEndsAt(subscription: Subscription): string | undefined {
  const end = subscription.cancelAtPeriodEnd || subscription.providerStatus === "cancelled" ||
    subscription.providerStatus === "expired" ? subscription.currentPeriodEnd : undefined;
  if (!subscription.graceEndsAt) return end;
  return !end || subscription.graceEndsAt < end ? subscription.graceEndsAt : end;
}

export const canProvision = (subscription: Subscription | undefined, now: number): subscription is Subscription => {
  if (subscription?.state !== "active") return false;
  const endsAt = accessEndsAt(subscription);
  return endsAt === undefined || Date.parse(endsAt) > now;
};

export function hostingSubscriptions(
  store: HostingStore, settings: ReturnType<typeof hostingSettings>, plans: ReturnType<typeof hostingPlans>,
  accounts: ReturnType<typeof accountAccess>, getCommerce: Commerce, rootPath: string, now: () => number,
) {
  const permits = Array.from({ length: 32 }, () => Semaphore.makeUnsafe(1));
  const permitFor = (id: string) => permits[Array.from(id).reduce((hash, character) =>
    (hash * 31 + (character.codePointAt(0) ?? 0)) % permits.length, 0)]!;
  const get = (id: string, tx?: Transaction) => store.get(subscriptions, id, tx);
  const require = (id: string, tx?: Transaction) => get(id, tx).pipe(Effect.flatMap(value =>
    value ? Effect.succeed(value) : Effect.fail(subscriptionMissing())));
  const put = (tx: Transaction, value: Subscription, exists = true) =>
    store.put(tx, subscriptions.collection, value.principalId, {
      ...value, billedProjects: [...value.billedProjects], allocatedProjects: value.billedProjects.length + value.reserved,
    }, exists);
  const page = (input: Omit<Parameters<typeof store.documents.findPage>[0], "collection">) =>
    dbCall(() => store.documents.findPage({ ...input, collection: subscriptions.collection })).pipe(
      Effect.flatMap(result => Effect.forEach(result.documents, item => subscriptions.read(item.data)).pipe(
        Effect.map(items => ({ items, next: result.next })),
      )),
    );
  const returnUrl = (base: string) => new URL(`${rootPath === "/" ? "" : rootPath}/`, base);

  const checkout = Effect.fn(function* (id: string, planId: string) {
    const config = yield* settings.require();
    const commerce = yield* getCommerce();
    const existing = yield* get(id);
    if (existing) {
      if (existing.state === "pending" && existing.planId === planId && existing.checkoutId) {
        const session = yield* commerce.checkouts.get(existing.checkoutId).pipe(Effect.mapError(paymentFailure));
        if (session?.status === "open" && session.customerId === existing.ecommerceCustomerId) return { url: session.url };
      }
      return yield* checkoutPending();
    }
    const email = yield* accounts.billingEmail(id);
    const checkoutAttempt = crypto.randomUUID();
    const ecommerceCustomerId = `hosting:${id}`;
    const plan = yield* store.transaction(tx => Effect.gen(function* () {
      if (yield* get(id, tx)) return yield* checkoutPending();
      const current = yield* plans.requirePlan(planId, tx);
      if (!current.active) return yield* plans.planNotFound();
      yield* put(tx, {
        principalId: id, planId, state: "pending", provider: config.provider, ecommerceCustomerId,
        checkoutAttempt, billedProjects: [], reserved: 0, updatedAt: timestamp(now),
      }, false);
      return current;
    }));
    const abandonUnsubmitted = () => store.transaction(tx => Effect.gen(function* () {
      const latest = yield* get(id, tx);
      if (latest?.state === "pending" && latest.checkoutAttempt === checkoutAttempt) {
        yield* dbCall(() => tx.delete({ collection: subscriptions.collection, id }));
      }
    }));
    const customer = yield* Effect.gen(function* () {
      return (yield* commerce.customers.getById(ecommerceCustomerId)) ??
        (yield* commerce.customers.create({ id: ecommerceCustomerId, principalId: id, email }));
    }).pipe(Effect.catch(() => abandonUnsubmitted().pipe(Effect.andThen(Effect.fail(paymentFailure())))));
    if (customer.principalId !== id) {
      yield* abandonUnsubmitted();
      return yield* paymentFailure();
    }

    const success = returnUrl(config.publicBaseUrl);
    success.searchParams.set("hosting", "checkout-done");
    const session = yield* commerce.checkouts.create({
      provider: config.provider, customerId: customer.id, mode: "subscription",
      lines: [{ name: plan.title, ...plan.price, quantity: 1 }],
      successUrl: success.href, cancelUrl: returnUrl(config.publicBaseUrl).href,
      metadata: { hostingPlan: plan.id, principalId: id, hostingAttempt: checkoutAttempt },
    }).pipe(Effect.catch(error => {
      // Only definitive pre-submission errors make it safe to offer another purchase.
      const refused = ["UnknownProvider", "CheckoutUnsupported", "InvalidInput", "NotFound", "ProviderNotConfigured"].includes(error._tag);
      return (refused ? abandonUnsubmitted() : Effect.void).pipe(Effect.andThen(Effect.fail(paymentFailure())));
    }));
    yield* store.transaction(tx => Effect.gen(function* () {
      const current = yield* require(id, tx);
      if (current.checkoutAttempt !== checkoutAttempt) return yield* revisionConflict();
      yield* put(tx, { ...current, checkoutId: session.id, updatedAt: timestamp(now) });
    }));
    return { url: session.url };
  });

  const fulfill = Effect.fn(function* (message: Message) {
    if (message.type !== "commerce.checkout.completed" && message.type !== "commerce.subscription.updated") return;
    const event = yield* Effect.try({ try: () => readMessage(message.payload), catch: paymentFailure });
    if (!event.metadata?.hostingAttempt) return;
    const subscriptionId = message.type === "commerce.checkout.completed" ? event.subscriptionId : event.id;
    if (!subscriptionId) return;
    const commerce = yield* getCommerce();
    const billing = yield* commerce.repositories.subscriptions.findById(subscriptionId).pipe(Effect.mapError(paymentFailure));
    if (!billing?.metadata?.hostingAttempt || typeof billing.metadata.principalId !== "string" || typeof billing.metadata.hostingPlan !== "string") return;
    const customer = yield* commerce.customers.getById(billing.customerId).pipe(Effect.mapError(paymentFailure));
    if (customer?.principalId !== billing.metadata.principalId) return;
    const principalId = customer.principalId;
    const config = yield* settings.require();
    const providerUpdatedAt = (billing.providerUpdatedAt ?? billing.updatedAt).toISOString();
    yield* permitFor(principalId).withPermit(store.transaction(tx => Effect.gen(function* () {
      const current = yield* get(principalId, tx);
      if (!current || current.planId !== billing.metadata?.hostingPlan || current.checkoutAttempt !== billing.metadata?.hostingAttempt ||
          current.provider !== billing.provider || current.ecommerceCustomerId !== billing.customerId ||
          current.ecommerceSubscriptionId && current.ecommerceSubscriptionId !== subscriptionId ||
          current.lastMessageId === message.id) return;
      const next = nextState(current, billing, now());
      const lapseGraceDays = current.lapseGraceDays ?? config.graceDays;
      // The canonical subscription stops stale events from changing the state. Older events
      // from this same unpaid period can still establish when that period first began.
      const belongsToLapse = isLapse(billing.status) && isLapse(event.status) &&
        message.occurredAt >= (current.activeConfirmedAt ?? billing.createdAt.toISOString()) &&
        message.occurredAt <= providerUpdatedAt;
      const lapseStartedAt = belongsToLapse ? message.occurredAt : providerUpdatedAt;
      const candidate = new Date(Date.parse(lapseStartedAt) + lapseGraceDays * dayMs).toISOString();
      if (current.providerUpdatedAt && current.providerUpdatedAt >= providerUpdatedAt) {
        if (current.providerUpdatedAt === providerUpdatedAt && current.state === "past_due" &&
            belongsToLapse && current.graceEndsAt && candidate < current.graceEndsAt) {
          const corrected = { ...current, graceEndsAt: candidate, updatedAt: timestamp(now) };
          yield* put(tx, { ...corrected, reviewAfter: current.entitlementsPending ? timestamp(now) : accessEndsAt(corrected) });
        }
        return;
      }
      const periodEnd = billing.currentPeriodEnd?.toISOString();
      const graceEndsAt = next === "past_due" ?
        current.graceEndsAt && current.graceEndsAt < candidate ? current.graceEndsAt : candidate : undefined;
      const { currentPeriodEnd: oldPeriodEnd, graceEndsAt: _grace, reviewAfter: _review,
        entitlementsPending: _pending, lapseGraceDays: _days, ...previous } = current;
      const currentPeriodEnd = periodEnd ?? oldPeriodEnd;
      const nextRecord = {
        ...previous, state: next, ecommerceSubscriptionId: subscriptionId, providerStatus: billing.status,
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
        ...(graceEndsAt ? { graceEndsAt, lapseGraceDays } : {}),
        ...(next === "active" && billing.status === "active" ? { activeConfirmedAt: providerUpdatedAt } : {}),
        cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
        providerUpdatedAt, lastMessageId: message.id, updatedAt: timestamp(now),
      };
      const changedSuspension = (next === "suspended") !== (current.state === "suspended");
      const entitlementsPending = current.entitlementsPending || changedSuspension && current.billedProjects.length > 0;
      const reviewAfter = entitlementsPending ? timestamp(now) : next === "suspended" ? undefined : accessEndsAt(nextRecord);
      yield* put(tx, {
        ...nextRecord, ...(entitlementsPending ? { entitlementsPending } : {}), ...(reviewAfter ? { reviewAfter } : {}),
      });
    })));
  });

  const authenticated = { authenticated: true };
  const routes = [
    route("subscriptions", "list", "GET", { permissions: ["hosting.view"] }, ({ query }) => Effect.gen(function* () {
      const limit = query.get("limit") ?? "50";
      const after = query.get("after") ?? undefined;
      if (!/^\d{1,2}$/u.test(limit) || Number(limit) < 1 || Number(limit) > 50 || after !== undefined && (!after || after.length > 2048)) {
        return yield* invalid("Supply a limit of 1–50 and an optional subscription cursor.");
      }
      const result = yield* page({ limit: Number(limit), after: after as Parameters<typeof page>[0]["after"] });
      return ok({ subscriptions: result.items.map(publicSubscription), next: result.next });
    })),
    route("subscription", "get", "GET", authenticated, ({ principal }) => Effect.gen(function* () {
      const id = yield* human(principal);
      yield* settings.require();
      const current = yield* require(id);
      const plan = yield* plans.requirePlan(current.planId);
      return ok({ subscription: publicSubscription(current), plan });
    })),
    route("checkout", "create", "POST", authenticated, ({ principal, body }) => Effect.gen(function* () {
      const id = yield* human(principal);
      const { planId } = yield* decode(readCheckoutInput, body, "Choose a hosting plan.");
      return ok(yield* checkout(id, planId));
    })),
    route("portal", "create", "POST", authenticated, ({ principal }) => Effect.gen(function* () {
      const id = yield* human(principal);
      const config = yield* settings.require();
      const current = yield* require(id);
      if (!current.ecommerceSubscriptionId) return yield* inactive();
      const commerce = yield* getCommerce();
      const portal = yield* commerce.customers.portal(current.ecommerceCustomerId, {
        provider: current.provider, returnUrl: returnUrl(config.publicBaseUrl).href,
      }).pipe(Effect.mapError(paymentFailure));
      return ok(portal);
    })),
  ];
  return { collection: subscriptions.collection, get, require, put, page, permitFor, fulfill, routes };
}
