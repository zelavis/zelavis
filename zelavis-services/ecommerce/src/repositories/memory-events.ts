import { Effect, Semaphore } from "effect";
import type { EcommerceRepositories, ProviderEventRepository } from "../contracts/repositories.js";
import type { ProviderEvent } from "../contracts/payment-provider.js";
import { planProviderEvent, type EventState } from "../services/provider-events.js";

/** In-memory counterpart to the database's atomic event batch. */
export function memoryEvents(repositories: Omit<EcommerceRepositories, "events">, emit: (provider: string, event: ProviderEvent, payload: unknown) => void): ProviderEventRepository {
  const applied = new Set<string>();
  const permit = Semaphore.makeUnsafe(1);
  return { apply: (provider, event) => permit.withPermit(Effect.uninterruptible(Effect.gen(function* () {
    const id = `${provider}:${event.eventId}`;
    if (applied.has(id)) return false;
    const state: EventState = {};
    if (event.type === "checkout.completed") {
      state.checkout = (yield* repositories.checkouts.list()).find(value => value.provider === provider && value.reference === event.checkoutReference);
      if (state.checkout) state.customer = yield* repositories.customers.findById(state.checkout.customerId);
    } else if (event.type === "subscription.updated") {
      state.subscription = (yield* repositories.subscriptions.list()).find(value => value.provider === provider && value.reference === event.subscriptionReference);
    } else {
      state.payment = (yield* repositories.paymentAttempts.list()).find(value => value.provider === provider && value.reference === event.paymentReference);
      if (!state.payment && event.subscriptionReference) state.subscription = (yield* repositories.subscriptions.list()).find(value => value.provider === provider && value.reference === event.subscriptionReference);
    }
    const plan = planProviderEvent(provider, event, state);
    if (!plan) return false;
    // Default memory repositories cannot fail. Durable/custom stores supply their own atomic events repository.
    for (const change of plan.changes) {
      const repository = repositories[change.kind];
      yield* (change.insert ? repository.create : repository.update)(change.value as never);
    }
    emit(provider, event, plan.payload);
    applied.add(id);
    return true;
  }))) };
}
