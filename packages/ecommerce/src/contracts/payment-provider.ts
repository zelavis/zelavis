import type {
  BillingSubscription,
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

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentAttempt>;
  capturePayment?(input: CapturePaymentInput): Promise<PaymentAttempt>;
  refundPayment?(input: RefundPaymentInput): Promise<PaymentAttempt>;
  createSubscription?(input: CreateSubscriptionInput): Promise<BillingSubscription>;
  cancelSubscription?(input: CancelSubscriptionInput): Promise<BillingSubscription>;
}
