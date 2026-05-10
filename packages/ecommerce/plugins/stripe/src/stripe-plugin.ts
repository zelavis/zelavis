import {
  type BillingSubscription,
  type CancelSubscriptionInput,
  defineEcommercePlugin,
  type CapturePaymentInput,
  type CreatePaymentInput,
  type CreateSubscriptionInput,
  type PaymentAttempt,
  type PaymentProvider,
  type RefundPaymentInput,
} from "@zelavis/ecommerce";
import Stripe from "stripe";

const DEFAULT_APP_INFO = {
  name: "@zelavis/ecommerce-stripe",
  version: "1.0.0",
};

export interface StripeRuntimeConfig {
  httpClient?: Stripe.StripeConfig["httpClient"];
  maxNetworkRetries?: Stripe.StripeConfig["maxNetworkRetries"];
  timeout?: Stripe.StripeConfig["timeout"];
  telemetry?: Stripe.StripeConfig["telemetry"];
  stripeAccount?: Stripe.StripeConfig["stripeAccount"];
  stripeContext?: Stripe.StripeConfig["stripeContext"];
}

export interface StripePluginOptions {
  secretKey?: string;
  client?: Stripe;
  apiVersion?: Stripe.LatestApiVersion;
  runtime?: StripeRuntimeConfig;
  getPaymentIntentParams?: (
    input: CreatePaymentInput,
  ) => Partial<Stripe.PaymentIntentCreateParams> | Promise<Partial<Stripe.PaymentIntentCreateParams>>;
  getCreatePaymentIdempotencyKey?: (input: CreatePaymentInput) => string | undefined;
  getCapturePaymentIdempotencyKey?: (input: CapturePaymentInput) => string | undefined;
  getRefundPaymentIdempotencyKey?: (input: RefundPaymentInput) => string | undefined;
  getCreateSubscriptionIdempotencyKey?: (input: CreateSubscriptionInput) => string | undefined;
  getCancelSubscriptionIdempotencyKey?: (input: CancelSubscriptionInput) => string | undefined;
  appInfo?: Stripe.StripeConfig["appInfo"];
}

export interface FetchStripeRuntimeOptions {
  fetchFn?: Function;
  maxNetworkRetries?: Stripe.StripeConfig["maxNetworkRetries"];
  timeout?: Stripe.StripeConfig["timeout"];
  telemetry?: Stripe.StripeConfig["telemetry"];
  stripeAccount?: Stripe.StripeConfig["stripeAccount"];
  stripeContext?: Stripe.StripeConfig["stripeContext"];
}

export function createStripeClient(options: StripePluginOptions): Stripe {
  if (options.client) {
    return options.client;
  }

  if (!options.secretKey) {
    throw new TypeError("Stripe plugin requires either a configured client or a secretKey.");
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

export function createStripeWebhookCryptoProvider(subtleCrypto?: unknown): Stripe.CryptoProvider {
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
  const resolvedInterval = recurring?.interval ?? fallback.interval;
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

export function createStripePaymentProvider(options: StripePluginOptions = {}): PaymentProvider {
  const stripe = createStripeClient(options);

  return {
    async createPayment(input: CreatePaymentInput): Promise<PaymentAttempt> {
      const extraParams = (await options.getPaymentIntentParams?.(input)) ?? {};
      const createParams: Stripe.PaymentIntentCreateParams = {
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        metadata: toStripeMetadata(input),
        ...extraParams,
      };

      if (!createParams.payment_method_types && !createParams.automatic_payment_methods) {
        createParams.automatic_payment_methods = { enabled: true };
      }

      const paymentIntent = await stripe.paymentIntents.create(
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
      const paymentIntent = await stripe.paymentIntents.capture(input.paymentAttempt.reference ?? input.paymentAttempt.id, {
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
      const refund = await stripe.refunds.create(
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

      const subscription = await stripe.subscriptions.create(
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
      const cancelled = await stripe.subscriptions.cancel(
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

export function stripePlugin(options: StripePluginOptions = {}) {
  return defineEcommercePlugin({
    name: "stripe",
    setup(api) {
      api.payments.registerProvider("stripe", createStripePaymentProvider(options));
    },
  });
}
