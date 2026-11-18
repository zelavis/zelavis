import type {
  BillingSubscription,
  Customer,
  SubscriptionStatus,
  Order,
  PaymentAttempt,
  SubscriptionInterval,
} from "../domain/entities.js";

export interface CreatePaymentInput {
  order: Order;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface CapturePaymentInput {
  paymentAttempt: PaymentAttempt;
  metadata?: Record<string, unknown>;
}

export interface RefundPaymentInput {
  paymentAttempt: PaymentAttempt;
  amount?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateSubscriptionInput {
  customerId: string;
  amount: number;
  currency: string;
  interval: SubscriptionInterval;
  intervalCount?: number;
  trialPeriodDays?: number;
  referenceId?: string;
  providerCustomerReference?: string;
  providerPlanReference?: string;
  providerProductReference?: string;
  metadata?: Record<string, unknown>;
}

export interface CancelSubscriptionInput {
  subscription: BillingSubscription;
  metadata?: Record<string, unknown>;
}

export interface CheckoutLine { readonly name: string; readonly amount: number; readonly currency: string; readonly quantity: number; readonly interval?: SubscriptionInterval; readonly intervalCount?: number }
export interface CreateCheckoutInput {
  readonly checkoutId: string; readonly mode: "payment" | "subscription"; readonly customer: Customer;
  readonly lines: readonly CheckoutLine[]; readonly successUrl: string; readonly cancelUrl: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface CheckoutSession { readonly reference: string; readonly url: string; readonly expiresAt?: Date; readonly customerReference?: string }
export interface CreatePortalInput { readonly customer: Customer; readonly customerReference: string; readonly returnUrl: string }
export type ProviderEvent =
  | { readonly type: "checkout.completed"; readonly eventId: string; readonly occurredAt: Date; readonly checkoutReference: string; readonly customerReference?: string; readonly subscriptionReference?: string; readonly paymentReference?: string }
  | { readonly type: "subscription.updated"; readonly eventId: string; readonly occurredAt: Date; readonly subscriptionReference: string; readonly status: SubscriptionStatus; readonly currentPeriodStart?: Date; readonly currentPeriodEnd?: Date; readonly cancelAtPeriodEnd: boolean }
  | { readonly type: "payment.succeeded" | "payment.failed"; readonly eventId: string; readonly occurredAt: Date; readonly paymentReference: string; readonly amount: number; readonly currency: string; readonly subscriptionReference?: string };

export interface PaymentProvider {
  createCheckout?(input: CreateCheckoutInput): Promise<CheckoutSession>;
  createPortal?(input: CreatePortalInput): Promise<{ readonly url: string }>;
  parseWebhook?(input: { readonly headers: Headers; readonly rawBody: string }): Promise<readonly ProviderEvent[]>;
  createPayment(input: CreatePaymentInput): Promise<PaymentAttempt>;
  capturePayment?(input: CapturePaymentInput): Promise<PaymentAttempt>;
  refundPayment?(input: RefundPaymentInput): Promise<PaymentAttempt>;
  createSubscription?(input: CreateSubscriptionInput): Promise<BillingSubscription>;
  cancelSubscription?(input: CancelSubscriptionInput): Promise<BillingSubscription>;
}
