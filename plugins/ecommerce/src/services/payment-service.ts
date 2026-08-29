import type { PaymentProvider } from "../contracts/payment-provider.js";
import type {
  CreateSubscriptionInput,
  CancelSubscriptionInput,
} from "../contracts/payment-provider.js";
import type {
  PaymentAttemptRepository,
  SubscriptionRepository,
} from "../contracts/repositories.js";
import type { BillingSubscription, Order, PaymentAttempt } from "../domain/entities.js";

export interface CancelSubscriptionOptions {
  providerName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Payment and Recurring Subscription Service
 *
 * Architecture & Recurring Subscription Lifecycle Notes:
 * --------------------------------------------------------
 * Subscriptions allow customers to be billed on a recurring cadence (day, week, month, year).
 *
 * Learned patterns from recurring subscription prototypes (e.g., Stripe & PayPal integrations):
 *
 * 1. Customer & Provider Identity Binding:
 *    - A local Zelavis customer (`customerId`) maps to an external provider customer entity
 *      (`providerCustomerReference`, e.g., Stripe's `cus_123` or PayPal's `payer_id`).
 *    - Reusing existing provider customer references prevents duplicate customer profiles
 *      in payment gateways.
 *
 * 2. Plan vs. Dynamic Ad-Hoc Recurring Items:
 *    - Pre-defined plans: `providerPlanReference` specifies an existing price/plan in the provider
 *      (e.g., Stripe Price `price_xxx`, PayPal Plan `P-xxx`).
 *    - Dynamic plans: If no plan reference is provided, the provider adapter creates or resolves
 *      a product/price dynamically using `amount`, `currency`, `interval`, and `intervalCount`.
 *
 * 3. Scheduling, Intervals, and Trials:
 *    - Standard intervals: "day", "week", "month", "year".
 *    - Interval count: Multiplier for the interval (e.g. interval="month", intervalCount=3 for quarterly).
 *    - Trial periods: `trialPeriodDays` shifts the billing start date forward.
 *
 * 4. Idempotency & Tracking:
 *    - `referenceId` provides an external tracking token (e.g., client order/subscription key)
 *      which is passed as idempotency key or metadata to avoid duplicate subscriptions.
 *
 * 5. Lifecycle Status Transitions:
 *    - "pending": Subscription created, waiting for approval, first payment, or trial start.
 *    - "active": In good standing; recurring renewals succeeding.
 *    - "past_due": Renewal payment failed; merchant/gateway in retry/dunning cycle.
 *    - "cancelled": Terminated by customer or merchant (either immediately or at period end).
 *    - "expired": Ended after reaching maximum billing cycles or completion.
 *    - "failed": Permanent failure to establish or authorize subscription.
 *
 * 6. Webhooks & Event Reconciliation (Future Platform Event Integration):
 *    - Providers notify Zelavis of renewals via webhooks (e.g., `invoice.paid`, `invoice.payment_failed`,
 *      `customer.subscription.deleted` in Stripe; `PAYMENT.SALE.COMPLETED`, `BILLING.SUBSCRIPTION.CANCELLED` in PayPal).
 *    - Each renewal generates a new `PaymentAttempt` linked to the subscription, updating `currentPeriodEnd`.
 */
export class PaymentService {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly paymentAttemptRepository: PaymentAttemptRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
  ) {}

  registerProvider(name: string, provider: PaymentProvider): PaymentProvider {
    if (!name) {
      throw new TypeError("Payment provider registration requires a string name.");
    }

    this.providers.set(name, provider);
    return provider;
  }

  getProvider(name: string): PaymentProvider | null {
    return this.providers.get(name) ?? null;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async createPayment(order: Order, providerName: string): Promise<PaymentAttempt> {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Unknown payment provider: ${providerName}`);
    }

    const paymentAttempt = await provider.createPayment({
      order,
      amount: order.totals.grandTotal,
      currency: order.totals.currency,
    });

    return this.paymentAttemptRepository.create(paymentAttempt);
  }

  async listPaymentAttempts(): Promise<PaymentAttempt[]> {
    return this.paymentAttemptRepository.list();
  }

  async createSubscription(
    input: CreateSubscriptionInput,
    providerName: string,
  ): Promise<BillingSubscription> {
    const provider = this.providers.get(providerName);

    if (!provider?.createSubscription) {
      throw new Error(`Provider ${providerName} does not support subscription creation.`);
    }

    const subscription = await provider.createSubscription({
      ...input,
      intervalCount: input.intervalCount ?? 1,
    });

    return this.subscriptionRepository.create(subscription);
  }

  async getSubscriptionById(id: string): Promise<BillingSubscription | null> {
    return this.subscriptionRepository.findById(id);
  }

  async listSubscriptions(): Promise<BillingSubscription[]> {
    return this.subscriptionRepository.list();
  }

  async cancelSubscription(
    subscriptionId: string,
    options: CancelSubscriptionOptions = {},
  ): Promise<BillingSubscription> {
    const existing = await this.subscriptionRepository.findById(subscriptionId);

    if (!existing) {
      throw new Error(`Subscription ${subscriptionId} was not found.`);
    }

    const providerName = options.providerName ?? existing.provider;
    const provider = this.providers.get(providerName);

    if (!provider?.cancelSubscription) {
      throw new Error(`Provider ${providerName} does not support subscription cancellation.`);
    }

    const updated = await provider.cancelSubscription({
      subscription: existing,
      metadata: options.metadata,
    } satisfies CancelSubscriptionInput);

    return this.subscriptionRepository.update(updated);
  }
}
