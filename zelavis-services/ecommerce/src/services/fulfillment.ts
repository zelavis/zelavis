import { Effect, Fiber, Schema, Semaphore } from "effect";
import { InvalidInput, StorageFailure } from "../errors.js";
import type { ZelavisServerPlugin } from "zelavis/core";

export interface FulfillmentMessage {
  readonly id: string;
  readonly type: "commerce.checkout.completed" | "commerce.subscription.updated" | "commerce.payment.succeeded" | "commerce.payment.failed";
  readonly payload: unknown;
  readonly occurredAt: string;
}
export const Delivery = Schema.Struct({
  id: Schema.String, messageId: Schema.String, handler: Schema.String, attempts: Schema.Number,
  nextAttemptAt: Schema.Number, lastError: Schema.optional(Schema.String), deliveredAt: Schema.optional(Schema.String),
  failed: Schema.Boolean,
});
export type Delivery = typeof Delivery.Type;
export function decodeDelivery(value: unknown): Delivery {
  const delivery = Schema.decodeUnknownSync(Delivery)(value);
  if (!delivery.id || delivery.id.length > 256 || !delivery.messageId || delivery.messageId.length > 200 || !/^[a-z][a-z0-9._-]{0,63}$/.test(delivery.handler) || delivery.id !== `${delivery.messageId}:${delivery.handler}` || !Number.isSafeInteger(delivery.attempts) || delivery.attempts < 1 || !Number.isSafeInteger(delivery.nextAttemptAt) || delivery.nextAttemptAt < 0 || delivery.lastError && delivery.lastError.length > 512 || delivery.deliveredAt && !Number.isFinite(Date.parse(delivery.deliveredAt)) || delivery.failed && delivery.deliveredAt) throw new TypeError("Invalid fulfillment delivery record.");
  return delivery;
}

export function decodeFulfillmentMessage(value: { id: string; topic: string; payload: Record<string, unknown> }): FulfillmentMessage {
  if (!["commerce.checkout.completed", "commerce.subscription.updated", "commerce.payment.succeeded", "commerce.payment.failed"].includes(value.topic) || typeof value.payload.occurredAt !== "string" || !Number.isFinite(Date.parse(value.payload.occurredAt)) || !value.payload.record || typeof value.payload.record !== "object" || Array.isArray(value.payload.record)) throw new TypeError("Invalid fulfillment message.");
  return { id: value.id, type: value.topic as FulfillmentMessage["type"], payload: value.payload.record, occurredAt: value.payload.occurredAt };
}

export interface FulfillmentRepository {
  read(after?: string): Effect.Effect<{ messages: readonly FulfillmentMessage[]; cursor?: string; more: boolean }, StorageFailure>;
  get(id: string): Effect.Effect<Delivery | undefined, StorageFailure>;
  save(delivery: Delivery): Effect.Effect<void, StorageFailure>;
  remove(message: string, deliveries: readonly string[]): Effect.Effect<void, StorageFailure>;
  failures(after?: string): Effect.Effect<{ deliveries: readonly Delivery[]; next?: string }, StorageFailure>;
}
export interface FulfillmentApi {
  registerHandler(name: string, handler: (message: FulfillmentMessage) => Promise<void>): Effect.Effect<void, InvalidInput>;
  failures(after?: string): ReturnType<FulfillmentRepository["failures"]>;
  /** One bounded delivery pass; also used by the runtime worker and deterministic tests. */
  deliver(): Effect.Effect<void, StorageFailure>;
}
const backoff = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

export function createFulfillment(repository: FulfillmentRepository, now: () => number = Date.now): FulfillmentApi {
  const running = new Set<string>();
  const handlers = new Map<string, (message: FulfillmentMessage) => Promise<void>>();
  const permit = Semaphore.makeUnsafe(1);
  let cursor: string | undefined;
  const registerHandler = Effect.fn(function* (name: string, handler: (message: FulfillmentMessage) => Promise<void>) {
    yield* permit.withPermit(Effect.gen(function* () {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name) || typeof handler !== "function" || handlers.has(name) || handlers.size >= 32) return yield* new InvalidInput({ field: "handler", message: "Invalid, duplicate or excessive fulfillment handler." });
    handlers.set(name, handler);
    }));
  });
  const deliver = () => permit.withPermit(Effect.gen(function* () {
    if (!handlers.size) return;
    const page = yield* repository.read(cursor).pipe(Effect.catch(error => {
      const cause = error.cause;
      if (cause && typeof cause === "object" && "_tag" in cause && (cause._tag === "CursorCompacted" || cause._tag === "CursorFromAnotherLife")) {
        cursor = undefined;
        return repository.read();
      }
      return Effect.fail(error);
    }));
    const registered = [...handlers.entries()];
    const jobs = page.messages.flatMap(message => registered.map(([name, handler]) => ({ message, name, handler })));
    yield* Effect.forEach(jobs, ({ message, name, handler }) => Effect.gen(function* () {
      const id = `${message.id}:${name}`;
      const existing = yield* repository.get(id);
      if (running.has(id) || running.size >= 4) return;
      if (existing?.deliveredAt || existing && existing.nextAttemptAt > now()) return;
      const attempts = (existing?.attempts ?? 0) + 1;
      if (!Number.isSafeInteger(attempts)) return yield* new StorageFailure({ operation: "fulfillmentAttempts", cause: "Delivery attempt counter exhausted" });
      const outcome = yield* Effect.tryPromise({ try: () => {
        running.add(id);
        try { return handler(message).finally(() => running.delete(id)); }
        catch (error) { running.delete(id); throw error; }
      }, catch: () => "handler_failed" }).pipe(
        Effect.timeout(30_000), Effect.result,
      );
      if (outcome._tag === "Success") yield* repository.save({ id, messageId: message.id, handler: name, attempts, nextAttemptAt: 0, deliveredAt: new Date(now()).toISOString(), failed: false });
      else yield* repository.save({ id, messageId: message.id, handler: name, attempts, nextAttemptAt: now() + backoff[Math.min(attempts - 1, backoff.length - 1)]!, lastError: "Fulfillment handler failed or timed out.", failed: true });
    }), { concurrency: 4, discard: true });
    for (const message of page.messages) {
      const ids = registered.map(([name]) => `${message.id}:${name}`);
      const deliveries = yield* Effect.forEach(ids, id => repository.get(id), { concurrency: 4 });
      if (deliveries.every(value => value?.deliveredAt)) yield* repository.remove(message.id, ids);
    }
    // Advance past non-message writes too. Wrap only at the end so one failing message cannot starve later ones.
    cursor = page.more ? page.cursor : undefined;
  }));
  return { registerHandler, failures: repository.failures, deliver };
}

export function fulfillmentWorker(api: FulfillmentApi): ZelavisServerPlugin {
  return ({ hooks }) => {
    let fiber: Fiber.Fiber<void, never> | undefined;
    hooks.hook("start", () => {
      fiber = Effect.runFork(Effect.forever(Effect.sleep(5000).pipe(Effect.andThen(api.deliver()),
        Effect.catch(() => Effect.logError("Ecommerce fulfillment delivery pass failed; pending messages remain queued.")))));
    });
    return () => fiber ? Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)) : undefined;
  };
}
