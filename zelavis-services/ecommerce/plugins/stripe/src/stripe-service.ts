import { Effect } from "effect";
import { zelavis } from "zelavis/sdk";
import type { ZelavisServiceSetupContext } from "zelavis/service";
import type { ZelavisServiceSecrets } from "zelavis";
import { InvalidWebhook, ProviderNotConfigured } from "@zelavis/ecommerce/errors";
import type { CreateCheckoutInput, CreatePortalInput, ProviderEvent } from "@zelavis/ecommerce";
import {
  type BillingSubscription,
  type CancelSubscriptionInput,
  type CapturePaymentInput,
  type CreatePaymentInput,
  type CreateSubscriptionInput,
  type EcommerceApi,
  type PaymentAttempt,
  type PaymentProvider,
  type RefundPaymentInput,
  type SubscriptionInterval,
} from "@zelavis/ecommerce";
import Stripe from "stripe";

const DEFAULT_APP_INFO = {
  name: "@zelavis/ecommerce-stripe",
  version: "1.0.0",
};

type StripeClientConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>;

export interface StripeRuntimeConfig {
  httpClient?: StripeClientConfig["httpClient"];
  maxNetworkRetries?: StripeClientConfig["maxNetworkRetries"];
  timeout?: StripeClientConfig["timeout"];
  telemetry?: StripeClientConfig["telemetry"];
  stripeAccount?: StripeClientConfig["stripeAccount"];
  stripeContext?: StripeClientConfig["stripeContext"];
}

export interface StripeServiceOptions {
  secretKey?: string;
  webhookSecret?: string;
  /** Provider-port credential lookup; a runtime setup supplies its own sealed store. */
  credentials?: () => Promise<{ secretKey?: string; webhookSecret?: string }>;
  client?: Stripe;
  apiVersion?: StripeClientConfig["apiVersion"];
  runtime?: StripeRuntimeConfig;
  getPaymentIntentParams?: (
    input: CreatePaymentInput,
  ) => Partial<Stripe.PaymentIntentCreateParams> | Promise<Partial<Stripe.PaymentIntentCreateParams>>;
  getCreatePaymentIdempotencyKey?: (input: CreatePaymentInput) => string | undefined;
  getCapturePaymentIdempotencyKey?: (input: CapturePaymentInput) => string | undefined;
  getRefundPaymentIdempotencyKey?: (input: RefundPaymentInput) => string | undefined;
  getCreateSubscriptionIdempotencyKey?: (input: CreateSubscriptionInput) => string | undefined;
  getCancelSubscriptionIdempotencyKey?: (input: CancelSubscriptionInput) => string | undefined;
  appInfo?: StripeClientConfig["appInfo"];
}

export interface FetchStripeRuntimeOptions {
  fetchFn?: Parameters<typeof Stripe.createFetchHttpClient>[0];
  maxNetworkRetries?: StripeClientConfig["maxNetworkRetries"];
  timeout?: StripeClientConfig["timeout"];
  telemetry?: StripeClientConfig["telemetry"];
  stripeAccount?: StripeClientConfig["stripeAccount"];
  stripeContext?: StripeClientConfig["stripeContext"];
}

export function createStripeClient(options: StripeServiceOptions): Stripe {
  if (options.client) {
    return options.client;
  }

  if (!options.secretKey) {
    throw new ProviderNotConfigured({ provider: "stripe" });
  }

  return new Stripe(options.secretKey, {
    ...(options.runtime ?? {}),
    ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
    appInfo: options.appInfo ?? DEFAULT_APP_INFO,
  });
}

export function createFetchStripeRuntime(
  options: FetchStripeRuntimeOptions = {},
): StripeRuntimeConfig {
  return {
    httpClient: Stripe.createFetchHttpClient(options.fetchFn),
    maxNetworkRetries: options.maxNetworkRetries,
    timeout: options.timeout,
    telemetry: options.telemetry,
    stripeAccount: options.stripeAccount,
    stripeContext: options.stripeContext,
  };
}

export function createStripeWebhookCryptoProvider(
  subtleCrypto?: Parameters<typeof Stripe.createSubtleCryptoProvider>[0],
): ReturnType<typeof Stripe.createSubtleCryptoProvider> {
  return Stripe.createSubtleCryptoProvider(subtleCrypto);
}

function toStripeMetadata(input: CreatePaymentInput): Record<string, string> {
  return {
    orderId: input.order.id,
    customerId: input.order.customerId,
    couponCodes: input.order.couponCodes.join(","),
    ...Object.fromEntries(
      Object.entries(input.metadata ?? {}).map(([key, value]) => [key, String(value)]),
    ),
  };
}

function toStripeSubscriptionMetadata(input: CreateSubscriptionInput): Record<string, string> {
  return {
    customerId: input.customerId,
    referenceId: input.referenceId ?? "",
    ...Object.fromEntries(
      Object.entries(input.metadata ?? {}).map(([key, value]) => [key, String(value)]),
    ),
  };
}

function mapStripeStatus(
  status: Stripe.PaymentIntent.Status,
): PaymentAttempt["status"] {
  switch (status) {
    case "requires_action":
    case "requires_confirmation":
    case "requires_payment_method":
      return "requires_action";
    case "requires_capture":
    case "processing":
      return "authorized";
    case "succeeded":
      return "captured";
    case "canceled":
      return "failed";
    default:
      return "failed";
  }
}

function mapRefundStatus(status: Stripe.Refund["status"]): PaymentAttempt["status"] {
  switch (status) {
    case "pending":
    case "requires_action":
      return "requires_action";
    case "succeeded":
      return "refunded";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "failed";
  }
}

function amountFromPaymentIntent(paymentIntent: Stripe.PaymentIntent): number {
  if (paymentIntent.status === "succeeded" && paymentIntent.amount_received > 0) {
    return paymentIntent.amount_received;
  }

  if (paymentIntent.status === "requires_capture" && paymentIntent.amount_capturable > 0) {
    return paymentIntent.amount_capturable;
  }

  return paymentIntent.amount;
}

function toPaymentAttempt(
  paymentIntent: Stripe.PaymentIntent,
  options: {
    provider?: string;
    fallbackOrderId?: string;
    updatedAt?: Date;
  } = {},
): PaymentAttempt {
  const createdAt = new Date(paymentIntent.created * 1000);
  const updatedAt = options.updatedAt ?? createdAt;

  return {
    id: paymentIntent.id,
    orderId: String(paymentIntent.metadata.orderId ?? options.fallbackOrderId ?? ""),
    provider: options.provider ?? "stripe",
    amount: amountFromPaymentIntent(paymentIntent),
    currency: paymentIntent.currency.toUpperCase(),
    status: mapStripeStatus(paymentIntent.status),
    reference: paymentIntent.id,
    metadata: {
      clientSecret: paymentIntent.client_secret ?? undefined,
      customerId: paymentIntent.customer ?? undefined,
      paymentMethod: paymentIntent.payment_method ?? undefined,
    },
    createdAt,
    updatedAt,
  };
}

function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): BillingSubscription["status"] {
  switch (status) {
    case "trialing":
    case "incomplete":
      return "pending";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "incomplete_expired":
      return "expired";
    case "paused":
      return "failed";
    default:
      return "failed";
  }
}

function toBillingSubscription(
  subscription: Stripe.Subscription,
  fallback: {
    customerId: string;
    amount: number;
    currency: string;
    interval: CreateSubscriptionInput["interval"];
    intervalCount: number;
  },
): BillingSubscription {
  const createdAt = new Date(subscription.created * 1000);
  const firstItem = subscription.items.data[0];
  const recurring = firstItem?.price.recurring;
  const rawInterval = recurring?.interval;
  const resolvedInterval = (
    rawInterval === "day" ||
    rawInterval === "week" ||
    rawInterval === "month" ||
    rawInterval === "year"
      ? rawInterval
      : fallback.interval
  ) as SubscriptionInterval;
  const resolvedIntervalCount = recurring?.interval_count ?? fallback.intervalCount;

  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : (subscription.customer as Stripe.Customer).id ?? fallback.customerId,
    provider: "stripe",
    amount: firstItem?.price.unit_amount ?? fallback.amount,
    currency: (firstItem?.price.currency ?? fallback.currency).toUpperCase(),
    interval: resolvedInterval,
    intervalCount: resolvedIntervalCount,
    status: mapStripeSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: new Date(subscription.start_date * 1000),
    currentPeriodEnd: subscription.ended_at ? new Date(subscription.ended_at * 1000) : undefined,
    reference: subscription.id,
    metadata: {
      stripeCustomerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : (subscription.customer as Stripe.Customer).id,
      latestInvoice:
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id,
    },
    createdAt,
    updatedAt: new Date(),
  };
}

function toRefundPaymentAttempt(
  refund: Stripe.Refund,
  input: RefundPaymentInput,
): PaymentAttempt {
  const createdAt = new Date(refund.created * 1000);

  return {
    id: refund.id,
    orderId: input.paymentAttempt.orderId,
    provider: "stripe",
    amount: refund.amount,
    currency: refund.currency.toUpperCase(),
    status: mapRefundStatus(refund.status),
    reference: refund.id,
    metadata: {
      paymentIntentId:
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id,
      chargeId: typeof refund.charge === "string" ? refund.charge : refund.charge?.id,
      pendingReason: refund.pending_reason ?? undefined,
      failureReason: refund.failure_reason ?? undefined,
    },
    createdAt,
    updatedAt: new Date(),
  };
}

function referenceOf(value: string | { id: string } | null | undefined): string | undefined { return typeof value === "string" ? value : value?.id; }

function mapStripeEvent(event: Stripe.Event): readonly ProviderEvent[] {
  const common = { eventId: event.id, occurredAt: new Date(event.created * 1000) };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      // Delayed payment methods fulfill only after the session is paid.
      if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return [];
      return [{ ...common, type: "checkout.completed", checkoutReference: session.id, customerReference: referenceOf(session.customer), subscriptionReference: referenceOf(session.subscription), paymentReference: referenceOf(session.payment_intent) }];
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const first = subscription.items.data[0];
      return [{ ...common, type: "subscription.updated", subscriptionReference: subscription.id, status: mapStripeSubscriptionStatus(subscription.status), cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodStart: first ? new Date(first.current_period_start * 1000) : undefined, currentPeriodEnd: first ? new Date(first.current_period_end * 1000) : undefined }];
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return [{ ...common, type: event.type === "invoice.paid" ? "payment.succeeded" : "payment.failed", paymentReference: invoice.id, amount: event.type === "invoice.paid" ? invoice.amount_paid : invoice.amount_due, currency: invoice.currency.toUpperCase(), subscriptionReference: referenceOf(invoice.parent?.subscription_details?.subscription) }];
    }
    default: return [];
  }
}

export function createStripePaymentProvider(options: StripeServiceOptions = {}): PaymentProvider {
  let cached: Stripe | undefined;
  let cachedKey: string | undefined;
  const credentials = () => options.credentials?.() ?? Promise.resolve({ secretKey: options.secretKey, webhookSecret: options.webhookSecret });
  const client = () => Effect.runPromise(Effect.gen(function* () {
    if (options.client) return options.client;
    const secretKey = options.secretKey ?? (yield* Effect.tryPromise(credentials)).secretKey;
    if (!secretKey) return yield* new ProviderNotConfigured({ provider: "stripe" });
    if (!cached || secretKey !== cachedKey) { cached = createStripeClient({ ...options, secretKey }); cachedKey = secretKey; }
    return cached;
  }));

  return {
    createCheckout: (input: CreateCheckoutInput) => Effect.runPromise(Effect.gen(function* () {
      const stripe = yield* Effect.tryPromise({ try: client, catch: cause => cause });
      const customer = input.customer.providerReferences?.stripe;
      const metadata = { ...input.metadata, checkoutId: input.checkoutId, customerId: input.customer.id };
      const session = yield* Effect.tryPromise(() => stripe.checkout.sessions.create({
        mode: input.mode, line_items: input.lines.map(line => ({ quantity: line.quantity, price_data: {
          currency: line.currency.toLowerCase(), unit_amount: line.amount, product_data: { name: line.name },
          ...(line.interval ? { recurring: { interval: line.interval, interval_count: line.intervalCount ?? 1 } } : {}),
        } })),
        ...(customer ? { customer } : { customer_email: input.customer.email }),
        client_reference_id: input.checkoutId, metadata,
        ...(input.mode === "subscription" ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
        success_url: input.successUrl, cancel_url: input.cancelUrl,
      }, { idempotencyKey: `checkout:${input.checkoutId}` }));
      if (!session.url) return yield* new ProviderNotConfigured({ provider: "stripe" });
      return { reference: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000), customerReference: referenceOf(session.customer) };
    })),
    createPortal: (input: CreatePortalInput) => Effect.runPromise(Effect.gen(function* () {
      const stripe = yield* Effect.tryPromise({ try: client, catch: cause => cause });
      const session = yield* Effect.tryPromise(() => stripe.billingPortal.sessions.create({ customer: input.customerReference, return_url: input.returnUrl }));
      return { url: session.url };
    })),
    parseWebhook: ({ headers, rawBody }) => Effect.runPromise(Effect.gen(function* () {
      const secret = options.webhookSecret ?? (yield* Effect.tryPromise(credentials)).webhookSecret;
      if (!secret) return yield* new ProviderNotConfigured({ provider: "stripe" });
      const stripe = options.client ?? new Stripe("webhook-verification", { telemetry: false });
      const event = yield* Effect.tryPromise({ try: () => stripe.webhooks.constructEventAsync(rawBody, headers.get("stripe-signature") ?? "", secret, undefined, createStripeWebhookCryptoProvider()), catch: () => new InvalidWebhook({}) });
      return mapStripeEvent(event);
    })),
    async createPayment(input: CreatePaymentInput): Promise<PaymentAttempt> {
      const extraParams = (await options.getPaymentIntentParams?.(input)) ?? {};
      const createParams: Stripe.PaymentIntentCreateParams = {
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        metadata: toStripeMetadata(input),
        ...extraParams,
      };

      if (!createParams.automatic_payment_methods) {
        createParams.automatic_payment_methods = { enabled: true };
      }

      const paymentIntent = await (await client()).paymentIntents.create(
        createParams,
        {
          idempotencyKey:
            options.getCreatePaymentIdempotencyKey?.(input) ??
            `order:${input.order.id}:create-payment-intent`,
        },
      );

      return toPaymentAttempt(paymentIntent, {
        fallbackOrderId: input.order.id,
      });
    },

    async capturePayment(input: CapturePaymentInput): Promise<PaymentAttempt> {
      const paymentIntent = await (await client()).paymentIntents.capture(input.paymentAttempt.reference ?? input.paymentAttempt.id, {
        metadata: Object.fromEntries(
          Object.entries(input.metadata ?? {}).map(([key, value]) => [key, String(value)]),
        ),
      }, {
        idempotencyKey:
          options.getCapturePaymentIdempotencyKey?.(input) ??
          `payment-intent:${input.paymentAttempt.reference ?? input.paymentAttempt.id}:capture`,
      });

      return toPaymentAttempt(paymentIntent, {
        fallbackOrderId: input.paymentAttempt.orderId,
        updatedAt: new Date(),
      });
    },

    async refundPayment(input: RefundPaymentInput): Promise<PaymentAttempt> {
      const paymentIntentId = input.paymentAttempt.reference ?? input.paymentAttempt.id;
      const refund = await (await client()).refunds.create(
        {
          payment_intent: paymentIntentId,
          ...(input.amount ? { amount: input.amount } : {}),
          metadata: Object.fromEntries(
            Object.entries(input.metadata ?? {}).map(([key, value]) => [key, String(value)]),
          ),
        },
        {
          idempotencyKey:
            options.getRefundPaymentIdempotencyKey?.(input) ??
            `payment-intent:${paymentIntentId}:refund:${input.amount ?? "full"}`,
        },
      );

      return toRefundPaymentAttempt(refund, input);
    },

    async createSubscription(input: CreateSubscriptionInput): Promise<BillingSubscription> {
      const customer = input.providerCustomerReference ?? input.customerId;
      const items: Stripe.SubscriptionCreateParams.Item[] = input.providerPlanReference
        ? [{ price: input.providerPlanReference }]
        : (() => {
            if (!input.providerProductReference) {
              throw new TypeError(
                "Stripe subscription creation requires providerPlanReference (Price ID) or providerProductReference (Product ID).",
              );
            }

            return [
              {
                price_data: {
                  currency: input.currency.toLowerCase(),
                  unit_amount: input.amount,
                  product: input.providerProductReference,
                  recurring: {
                    interval: input.interval,
                    interval_count: input.intervalCount ?? 1,
                  },
                },
              },
            ];
          })();

      const subscription = await (await client()).subscriptions.create(
        {
          customer,
          items,
          metadata: toStripeSubscriptionMetadata(input),
          ...(input.trialPeriodDays
            ? {
                trial_period_days: input.trialPeriodDays,
              }
            : {}),
          payment_behavior: "allow_incomplete",
        },
        {
          idempotencyKey:
            options.getCreateSubscriptionIdempotencyKey?.(input) ??
            `subscription:${input.referenceId ?? customer}:create`,
        },
      );

      return toBillingSubscription(subscription, {
        customerId: input.customerId,
        amount: input.amount,
        currency: input.currency,
        interval: input.interval,
        intervalCount: input.intervalCount ?? 1,
      });
    },

    async cancelSubscription(input: CancelSubscriptionInput): Promise<BillingSubscription> {
      const subscriptionId = input.subscription.reference ?? input.subscription.id;
      const cancelled = await (await client()).subscriptions.cancel(
        subscriptionId,
        {},
        {
          idempotencyKey:
            options.getCancelSubscriptionIdempotencyKey?.(input) ??
            `subscription:${subscriptionId}:cancel`,
        },
      );

      return toBillingSubscription(cancelled, {
        customerId: input.subscription.customerId,
        amount: input.subscription.amount,
        currency: input.subscription.currency,
        interval: input.subscription.interval,
        intervalCount: input.subscription.intervalCount,
      });
    },
  };
}

export function stripeService(options: StripeServiceOptions = {}) {
  const stores = new WeakMap<object, ZelavisServiceSecrets>();
  const setup = (context: ZelavisServiceSetupContext) => Effect.runPromise(Effect.gen(function* () {
    if (context.core.secrets) stores.set(context.registry, context.core.secrets);
    const status = () => Effect.gen(function* () {
      const secretKey = options.secretKey ?? (context.core.secrets ? yield* Effect.tryPromise(() => context.core.secrets!.get("stripe.secret-key")) : undefined);
      const webhookSecret = options.webhookSecret ?? (context.core.secrets ? yield* Effect.tryPromise(() => context.core.secrets!.get("stripe.webhook-secret")) : undefined);
      return { configured: { secretKey: !!secretKey || !!options.client, webhookSecret: !!webhookSecret }, ...(secretKey ? { secretKeyHint: `…${secretKey.slice(-4)}` } : {}) };
    });
    context.addEndpointGroup({ id: "@zelavis/ecommerce-stripe:settings", basePath: "/plugins/stripe", context: {}, origin: { type: "service", serviceName: context.service.name }, api: { v1: [
      { id: "stripe.settings.get", method: "GET", path: "/settings", access: { permissions: ["ecommerce.manage"] }, meta: { pluginResource: "settings", pluginAction: "get" }, handler: () => Effect.runPromise(status().pipe(Effect.map(body => ({ status: 200, body })))) },
      { id: "stripe.settings.set", method: "PUT", path: "/settings", access: { permissions: ["ecommerce.manage"] }, meta: { pluginResource: "settings", pluginAction: "set" }, handler: ({ body }) => Effect.runPromise(Effect.gen(function* () {
        if (!context.core.secrets) return { status: 409, body: { error: "secrets_unavailable" } };
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["secretKey", "webhookSecret"].includes(key))) return { status: 400, body: { error: "invalid_settings" } };
        const input = body as Record<string, unknown>;
        for (const key of ["secretKey", "webhookSecret"]) {
          const value = input[key];
          if (value !== undefined && (typeof value !== "string" || value.length > 4096 || value !== "" && !(key === "secretKey" ? /^sk_(test|live)_[A-Za-z0-9]+$/.test(value) : /^whsec_[A-Za-z0-9]+$/.test(value)))) return { status: 400, body: { error: "invalid_settings" } };
        }
        for (const [key, name] of [["secretKey", "stripe.secret-key"], ["webhookSecret", "stripe.webhook-secret"]] as const) {
          const value = input[key];
          if (typeof value === "string") {
            if (value === "") yield* Effect.tryPromise(() => context.core.secrets!.delete(name));
            else yield* Effect.tryPromise(() => context.core.secrets!.set(name, value));
          }
        }
        return { status: 200, body: yield* status() };
      }).pipe(Effect.catch(() => Effect.succeed({ status: 500, body: { error: "settings_unavailable" } })))) },
    ] } });
  }));
  return Object.freeze({
    name: "@zelavis/ecommerce-stripe", namespace: "stripe", kind: "plugin",
    capabilities: Object.freeze(["@zelavis/ecommerce:payments", "api:routes", "dashboard:menu"]),
    marketplace: Object.freeze({ title: "Stripe", summary: "Take card payments and manage subscriptions through Stripe.", categories: Object.freeze(["payments"]) }),
    setup,
    service: { name: "stripe", register(api: EcommerceApi) {
      const provider = createStripePaymentProvider({ ...options, credentials: () => Effect.runPromise(Effect.gen(function* () {
        const secrets = api.context.runtimeScope ? stores.get(api.context.runtimeScope) : undefined;
        return { secretKey: secrets ? yield* Effect.tryPromise(() => secrets.get("stripe.secret-key")) : undefined, webhookSecret: secrets ? yield* Effect.tryPromise(() => secrets.get("stripe.webhook-secret")) : undefined };
      })) });
      return api.runPromise(api.payments.registerProvider("stripe", provider));
    } },
  });
}

export function registerStripeMenu(): void {
  zelavis.plugins.ui.menus.create({ title: "Stripe", path: "/commerce/stripe", page: { id: "settings", title: "Stripe settings", bundle: "dashboard", file: "settings.html" } });
}

export interface StripePluginClient {
  readonly settings: {
    get(): Promise<{ configured: { secretKey: boolean; webhookSecret: boolean }; secretKeyHint?: string }>;
    set(input: { secretKey?: string; webhookSecret?: string }): Promise<{ configured: { secretKey: boolean; webhookSecret: boolean }; secretKeyHint?: string }>;
  };
}
declare module "zelavis/sdk" { interface PluginApiRegistry { readonly stripe?: StripePluginClient } }
