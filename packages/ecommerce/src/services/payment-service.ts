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
