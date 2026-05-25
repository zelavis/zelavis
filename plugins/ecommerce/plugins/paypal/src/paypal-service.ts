import {
  Client,
  CheckoutPaymentIntent,
  Environment,
  OrdersController,
  PaymentsController,
  type Configuration,
  type Order,
  type OrderRequest,
  type OrdersCapture,
  type Refund,
} from "@paypal/paypal-server-sdk";
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
} from "@zelavis/ecommerce";
import { defineService } from "zelavis/service";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export interface PayPalServiceOptions {
  client?: Client;
  clientConfig?: Partial<Configuration>;
  clientId?: string;
  clientSecret?: string;
  environment?: Environment | PayPalEnvironment;
  getOrderRequest?: (
    input: CreatePaymentInput,
    baseRequest: OrderRequest,
  ) => OrderRequest | Promise<OrderRequest>;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  getAccessToken?: () => Promise<string>;
  getCreateSubscriptionIdempotencyKey?: (input: CreateSubscriptionInput) => string | undefined;
  getCancelSubscriptionIdempotencyKey?: (input: CancelSubscriptionInput) => string | undefined;
}

export type PayPalEnvironment = "sandbox" | "production" | "live";

interface PayPalOAuthTokenResponse {
  access_token: string;
}

interface PayPalProductResponse {
  id: string;
}

interface PayPalPlanResponse {
  id: string;
}

interface PayPalSubscriptionResponse {
  id: string;
  status?: string;
  plan_id?: string;
  start_time?: string;
  status_update_time?: string;
  billing_info?: {
    next_billing_time?: string;
  };
  subscriber?: {
    payer_id?: string;
  };
}

function toBasicAuthHeader(clientId: string, clientSecret: string): string {
  const value = `${clientId}:${clientSecret}`;

  if (typeof globalThis.btoa === "function") {
    return `Basic ${globalThis.btoa(value)}`;
  }

  throw new Error(
    "PayPal OAuth token generation requires a global btoa() implementation in this runtime. Provide getAccessToken() to bypass this requirement.",
  );
}

function normalizePayPalEnvironment(
  value: PayPalServiceOptions["environment"] | Configuration["environment"] | undefined,
): Environment {
  if (!value) {
    return Environment.Sandbox;
  }

  if (value === Environment.Production) {
    return Environment.Production;
  }

  if (value === Environment.Sandbox) {
    return Environment.Sandbox;
  }

  const normalized = String(value).toLowerCase();
  if (normalized === "production" || normalized === "live") {
    return Environment.Production;
  }

  return Environment.Sandbox;
}

function createPayPalClient(options: PayPalServiceOptions): Client {
  if (options.client) {
    return options.client;
  }

  if (options.clientConfig) {
    return new Client(options.clientConfig);
  }

  if (!options.clientId || !options.clientSecret) {
    throw new TypeError(
      "PayPal service requires either a configured client, clientConfig, or clientId/clientSecret credentials.",
    );
  }

  return new Client({
    environment: normalizePayPalEnvironment(options.environment),
    clientCredentialsAuthCredentials: {
      oAuthClientId: options.clientId,
      oAuthClientSecret: options.clientSecret,
    },
  });
}

function resolvePayPalBaseUrl(options: PayPalServiceOptions): string {
  if (options.apiBaseUrl) {
    return options.apiBaseUrl.replace(/\/$/, "");
  }

  const environment = normalizePayPalEnvironment(
    options.environment ?? options.clientConfig?.environment,
  );
  return environment === Environment.Production
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken(options: PayPalServiceOptions): Promise<string> {
  if (options.getAccessToken) {
    return options.getAccessToken();
  }

  if (!options.clientId || !options.clientSecret) {
    throw new TypeError(
      "PayPal subscriptions require either getAccessToken() or clientId/clientSecret credentials.",
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${resolvePayPalBaseUrl(options)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: toBasicAuthHeader(options.clientId, options.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`PayPal OAuth token request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as PayPalOAuthTokenResponse;
  return data.access_token;
}

function formatPayPalAmount(amount: number, currency: string): string {
  const normalizedCurrency = currency.toUpperCase();

  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return amount.toString();
  }

  if (THREE_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return (amount / 1000).toFixed(3);
  }

  return (amount / 100).toFixed(2);
}

function getCurrencyScale(currency: string): number {
  const normalizedCurrency = currency.toUpperCase();

  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return 1;
  }

  if (THREE_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return 1000;
  }

  return 100;
}

function parsePayPalAmount(amount: string | undefined, currency: string): number {
  if (!amount) {
    return 0;
  }

  return Math.round(Number(amount) * getCurrencyScale(currency));
}

function toPayPalIntervalUnit(
  interval: CreateSubscriptionInput["interval"],
): "DAY" | "WEEK" | "MONTH" | "YEAR" {
  switch (interval) {
    case "day":
      return "DAY";
    case "week":
      return "WEEK";
    case "month":
      return "MONTH";
    case "year":
      return "YEAR";
    default:
      return "MONTH";
  }
}

function mapPayPalSubscriptionStatus(status?: string): BillingSubscription["status"] {
  switch (status) {
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "pending";
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "failed";
    default:
      return "failed";
  }
}

async function paypalRequest<TResponse>(
  options: PayPalServiceOptions,
  accessToken: string,
  path: string,
  init: RequestInit,
): Promise<TResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${resolvePayPalBaseUrl(options)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal API request failed (${response.status} ${response.statusText}): ${body}`);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return (await response.json()) as TResponse;
}

function toPayPalBillingSubscription(
  subscription: PayPalSubscriptionResponse,
  fallback: {
    customerId: string;
    amount: number;
    currency: string;
    interval: CreateSubscriptionInput["interval"];
    intervalCount: number;
  },
): BillingSubscription {
  const createdAt = subscription.start_time ? new Date(subscription.start_time) : new Date();

  return {
    id: subscription.id,
    customerId: subscription.subscriber?.payer_id ?? fallback.customerId,
    provider: "paypal",
    amount: fallback.amount,
    currency: fallback.currency.toUpperCase(),
    interval: fallback.interval,
    intervalCount: fallback.intervalCount,
    status: mapPayPalSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: false,
    currentPeriodStart: subscription.start_time ? new Date(subscription.start_time) : undefined,
    currentPeriodEnd: subscription.billing_info?.next_billing_time
      ? new Date(subscription.billing_info.next_billing_time)
      : undefined,
    reference: subscription.id,
    metadata: {
      paypalPlanId: subscription.plan_id,
      paypalStatus: subscription.status,
    },
    createdAt,
    updatedAt: subscription.status_update_time
      ? new Date(subscription.status_update_time)
      : new Date(),
  };
}

function buildBaseOrderRequest(input: CreatePaymentInput): OrderRequest {
  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: input.order.id,
        customId: input.order.id,
        description: `Order ${input.order.id}`,
        amount: {
          currencyCode: input.currency.toUpperCase(),
          value: formatPayPalAmount(input.amount, input.currency),
        },
      },
    ],
  };
}

function mapOrderStatus(status?: Order["status"]): PaymentAttempt["status"] {
  switch (status) {
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      return "requires_action";
    case "APPROVED":
      return "authorized";
    case "COMPLETED":
      return "captured";
    case "VOIDED":
      return "failed";
    default:
      return "failed";
  }
}

function mapCaptureStatus(status?: OrdersCapture["status"]): PaymentAttempt["status"] {
  switch (status) {
    case "COMPLETED":
      return "captured";
    case "PENDING":
      return "authorized";
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "refunded";
    case "DECLINED":
    case "FAILED":
      return "failed";
    default:
      return "failed";
  }
}

function mapRefundStatus(status?: Refund["status"]): PaymentAttempt["status"] {
  switch (status) {
    case "PENDING":
      return "requires_action";
    case "COMPLETED":
      return "refunded";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return "failed";
  }
}

function findApprovalUrl(order: Order): string | undefined {
  return order.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href;
}

function getCapturedPayment(order: Order): OrdersCapture | undefined {
  return order.purchaseUnits?.flatMap((purchaseUnit) => purchaseUnit.payments?.captures ?? [])[0];
}

function toOrderPaymentAttempt(
  order: Order,
  fallback: {
    orderId: string;
    amount: number;
    currency: string;
  },
): PaymentAttempt {
  const createdAt = order.createTime ? new Date(order.createTime) : new Date();
  const purchaseUnit = order.purchaseUnits?.[0];
  const resolvedCurrency = purchaseUnit?.amount?.currencyCode ?? fallback.currency.toUpperCase();

  return {
    id: order.id ?? `paypal_order_${createdAt.getTime()}`,
    orderId: purchaseUnit?.customId ?? purchaseUnit?.referenceId ?? order.id ?? fallback.orderId,
    provider: "paypal",
    amount: parsePayPalAmount(purchaseUnit?.amount?.value, resolvedCurrency) || fallback.amount,
    currency: resolvedCurrency,
    status: mapOrderStatus(order.status),
    reference: order.id,
    metadata: {
      approvalUrl: findApprovalUrl(order),
      paypalOrderId: order.id,
      paypalStatus: order.status,
    },
    createdAt,
    updatedAt: order.updateTime ? new Date(order.updateTime) : createdAt,
  };
}

function toCapturePaymentAttempt(order: Order, capture: OrdersCapture): PaymentAttempt {
  const createdAt = capture.createTime ? new Date(capture.createTime) : new Date();
  const currency = capture.amount?.currencyCode ?? "USD";

  return {
    id: capture.id ?? order.id ?? `paypal_capture_${createdAt.getTime()}`,
    orderId:
      order.purchaseUnits?.[0]?.customId ??
      order.purchaseUnits?.[0]?.referenceId ??
      order.id ??
      "",
    provider: "paypal",
    amount: parsePayPalAmount(capture.amount?.value, currency),
    currency,
    status: mapCaptureStatus(capture.status),
    reference: capture.id ?? order.id,
    metadata: {
      paypalOrderId: order.id,
      paypalCaptureId: capture.id,
      paypalStatus: capture.status,
    },
    createdAt,
    updatedAt: capture.updateTime ? new Date(capture.updateTime) : createdAt,
  };
}

function toRefundPaymentAttempt(refund: Refund, originalOrderId: string, captureId: string): PaymentAttempt {
  const createdAt = refund.createTime ? new Date(refund.createTime) : new Date();
  const currency = refund.amount?.currencyCode ?? "USD";

  return {
    id: refund.id ?? `paypal_refund_${createdAt.getTime()}`,
    orderId: originalOrderId,
    provider: "paypal",
    amount: parsePayPalAmount(refund.amount?.value, currency),
    currency,
    status: mapRefundStatus(refund.status),
    reference: refund.id ?? captureId,
    metadata: {
      paypalCaptureId: captureId,
      paypalRefundId: refund.id,
      paypalStatus: refund.status,
    },
    createdAt,
    updatedAt: refund.updateTime ? new Date(refund.updateTime) : createdAt,
  };
}

export function createPayPalPaymentProvider(
  options: PayPalServiceOptions = {},
): PaymentProvider {
  const client = createPayPalClient(options);
  const orders = new OrdersController(client);
  const payments = new PaymentsController(client);

  return {
    async createPayment(input: CreatePaymentInput): Promise<PaymentAttempt> {
      const baseOrderRequest = buildBaseOrderRequest(input);
      const request = (await options.getOrderRequest?.(input, baseOrderRequest)) ?? baseOrderRequest;
      const response = await orders.createOrder({
        body: request,
        prefer: "return=representation",
        paypalRequestId: `order:${input.order.id}:create`,
      });

      return toOrderPaymentAttempt(response.result, {
        orderId: input.order.id,
        amount: input.amount,
        currency: input.currency,
      });
    },

    async capturePayment(input: CapturePaymentInput): Promise<PaymentAttempt> {
      const orderId = String(input.paymentAttempt.metadata?.paypalOrderId ?? input.paymentAttempt.reference ?? input.paymentAttempt.id);
      const response = await orders.captureOrder({
        id: orderId,
        prefer: "return=representation",
        paypalRequestId: `order:${orderId}:capture`,
      });

      const capture = getCapturedPayment(response.result);
      if (!capture) {
        throw new Error(`PayPal capture response did not include a capture for order ${orderId}.`);
      }

      return toCapturePaymentAttempt(response.result, capture);
    },

    async refundPayment(input: RefundPaymentInput): Promise<PaymentAttempt> {
      const metadataCaptureId = input.paymentAttempt.metadata?.paypalCaptureId;
      if (typeof metadataCaptureId !== "string" || metadataCaptureId.length === 0) {
        throw new Error(
          "PayPal refund requires a captured payment attempt with metadata.paypalCaptureId.",
        );
      }

      const captureId = metadataCaptureId;
      const response = await payments.refundCapturedPayment({
        captureId,
        prefer: "return=representation",
        paypalRequestId: `capture:${captureId}:refund:${input.amount ?? "full"}`,
        body: input.amount
          ? {
              amount: {
                currencyCode: input.paymentAttempt.currency.toUpperCase(),
                value: formatPayPalAmount(input.amount, input.paymentAttempt.currency),
              },
            }
          : undefined,
      });

      return toRefundPaymentAttempt(
        response.result,
        input.paymentAttempt.orderId,
        captureId,
      );
    },

    async createSubscription(input: CreateSubscriptionInput): Promise<BillingSubscription> {
      const accessToken = await getPayPalAccessToken(options);
      let planId = input.providerPlanReference;

      if (!planId) {
        let productId = input.providerProductReference;

        if (!productId) {
          const product = await paypalRequest<PayPalProductResponse>(
            options,
            accessToken,
            "/v1/catalogs/products",
            {
              method: "POST",
              body: JSON.stringify({
                name:
                  typeof input.metadata?.productName === "string"
                    ? input.metadata.productName
                    : `Subscription Product ${input.referenceId ?? input.customerId}`,
                type: "SERVICE",
              }),
            },
          );

          productId = product.id;
        }

        const plan = await paypalRequest<PayPalPlanResponse>(
          options,
          accessToken,
          "/v1/billing/plans",
          {
            method: "POST",
            body: JSON.stringify({
              product_id: productId,
              name:
                typeof input.metadata?.planName === "string"
                  ? input.metadata.planName
                  : `Plan ${input.referenceId ?? input.customerId}`,
              status: "ACTIVE",
              billing_cycles: [
                {
                  frequency: {
                    interval_unit: toPayPalIntervalUnit(input.interval),
                    interval_count: input.intervalCount ?? 1,
                  },
                  tenure_type: "REGULAR",
                  sequence: 1,
                  total_cycles: 0,
                  pricing_scheme: {
                    fixed_price: {
                      value: formatPayPalAmount(input.amount, input.currency),
                      currency_code: input.currency.toUpperCase(),
                    },
                  },
                },
              ],
              payment_preferences: {
                auto_bill_outstanding: true,
                setup_fee_failure_action: "CONTINUE",
                payment_failure_threshold: 3,
              },
            }),
          },
        );

        planId = plan.id;
      }

      const subscription = await paypalRequest<PayPalSubscriptionResponse>(
        options,
        accessToken,
        "/v1/billing/subscriptions",
        {
          method: "POST",
          headers: {
            "PayPal-Request-Id":
              options.getCreateSubscriptionIdempotencyKey?.(input) ??
              `subscription:${input.referenceId ?? input.customerId}:create`,
          },
          body: JSON.stringify({
            plan_id: planId,
            custom_id: input.referenceId ?? input.customerId,
            ...(input.trialPeriodDays
              ? {
                  start_time: new Date(
                    Date.now() + input.trialPeriodDays * 24 * 60 * 60 * 1000,
                  ).toISOString(),
                }
              : {}),
          }),
        },
      );

      return toPayPalBillingSubscription(subscription, {
        customerId: input.customerId,
        amount: input.amount,
        currency: input.currency,
        interval: input.interval,
        intervalCount: input.intervalCount ?? 1,
      });
    },

    async cancelSubscription(input: CancelSubscriptionInput): Promise<BillingSubscription> {
      const accessToken = await getPayPalAccessToken(options);
      const subscriptionId = input.subscription.reference ?? input.subscription.id;

      await paypalRequest<void>(
        options,
        accessToken,
        `/v1/billing/subscriptions/${subscriptionId}/cancel`,
        {
          method: "POST",
          headers: {
            "PayPal-Request-Id":
              options.getCancelSubscriptionIdempotencyKey?.(input) ??
              `subscription:${subscriptionId}:cancel`,
          },
          body: JSON.stringify({
            reason:
              typeof input.metadata?.reason === "string"
                ? input.metadata.reason
                : "Cancelled by merchant",
          }),
        },
      );

      const subscription = await paypalRequest<PayPalSubscriptionResponse>(
        options,
        accessToken,
        `/v1/billing/subscriptions/${subscriptionId}`,
        {
          method: "GET",
        },
      );

      return toPayPalBillingSubscription(subscription, {
        customerId: input.subscription.customerId,
        amount: input.subscription.amount,
        currency: input.subscription.currency,
        interval: input.subscription.interval,
        intervalCount: input.subscription.intervalCount,
      });
    },
  };
}

export function paypalService(options: PayPalServiceOptions = {}) {
  return defineService<EcommerceApi>({
    name: "@zelavis/ecommerce-paypal",
    extends: "@zelavis/ecommerce",
    setup(api) {
      api.payments.registerProvider("paypal", createPayPalPaymentProvider(options));
    },
  });
}
