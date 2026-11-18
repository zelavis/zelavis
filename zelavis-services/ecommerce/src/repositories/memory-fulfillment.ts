import { Effect, Schema } from "effect";
import type { ProviderEvent } from "../contracts/payment-provider.js";
import type { Delivery, FulfillmentMessage, FulfillmentRepository } from "../services/fulfillment.js";

export function memoryFulfillment() {
  const messages = new Map<number, FulfillmentMessage>();
  const deliveries = new Map<string, Delivery>();
  let sequence = 0;
  const repository: FulfillmentRepository = {
    read: after => Effect.sync(() => {
      const page = [...messages].filter(([id]) => id > Number(after ?? 0)).slice(0, 51);
      return { messages: page.slice(0, 50).map(([, message]) => message), cursor: String(page.slice(0, 50).at(-1)?.[0] ?? sequence), more: page.length > 50 };
    }),
    get: id => Effect.sync(() => deliveries.get(id)),
    save: delivery => Effect.sync(() => { deliveries.set(delivery.id, delivery); }),
    remove: (message, ids) => Effect.sync(() => {
      for (const [id, value] of messages) if (value.id === message) messages.delete(id);
      for (const id of ids) deliveries.delete(id);
    }),
    failures: after => Effect.sync(() => {
      const matches = [...deliveries.values()].filter(value => value.failed && value.id > (after ?? "")).sort((a,b) => a.id < b.id ? -1 : 1).slice(0, 51);
      return { deliveries: matches.slice(0, 50), next: matches.length > 50 ? matches[49]!.id : undefined };
    }),
  };
  return { repository, emit: (provider: string, event: ProviderEvent, payload: unknown) => {
    messages.set(++sequence, { id: `${provider}:${event.eventId}`, type: `commerce.${event.type}`, payload: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(payload))), occurredAt: event.occurredAt.toISOString() });
  } };
}
