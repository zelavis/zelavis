/** Orders. */
import { Context, Effect, Layer } from "effect";
import type { Order } from "../domain/entities.js";
import { InvalidInput, type StorageFailure } from "../errors.js";
import { Repositories } from "./repositories.js";

export interface CreateOrderInput {
  id: string;
  customerId: string;
  items: Order["items"];
  couponCodes?: readonly string[];
  totals: Order["totals"];
  metadata?: Record<string, unknown>;
}

export class Orders extends Context.Service<Orders, {
  create(input: CreateOrderInput): Effect.Effect<Order, InvalidInput | StorageFailure>;
  getById(id: string): Effect.Effect<Order | undefined, StorageFailure>;
  list(): Effect.Effect<ReadonlyArray<Order>, StorageFailure>;
}>()("zelavis/ecommerce/Orders") {
  static readonly layer = Layer.effect(
    Orders,
    Effect.gen(function* () {
      const { orders } = yield* Repositories;

      const create = Effect.fn("Orders.create")(function* (input: CreateOrderInput) {
        if (!input.id) {
          return yield* new InvalidInput({ field: "id", message: "Order creation requires an id." });
        }
        if (!input.customerId) {
          return yield* new InvalidInput({
            field: "customerId",
            message: "Order creation requires a customerId.",
          });
        }
        if (input.items.length === 0) {
          return yield* new InvalidInput({
            field: "items",
            message: "Order creation requires at least one line item.",
          });
        }
        const now = new Date();
        return yield* orders.create({
          ...input,
          couponCodes: input.couponCodes ?? [],
          status: "draft",
          createdAt: now,
          updatedAt: now,
        } as Order);
      });

      return Orders.of({
        create,
        getById: (id) => orders.findById(id),
        list: () => orders.list(),
      });
    }),
  );
}
