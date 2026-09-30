/** Customers. */
import { Context, Effect, Layer } from "effect";
import type { Customer } from "../domain/entities.js";
import { InvalidInput, type StorageFailure } from "../errors.js";
import { Repositories } from "./repositories.js";

export interface CreateCustomerInput {
  id: string;
  accountId?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, unknown>;
}

export class Customers extends Context.Service<Customers, {
  create(input: CreateCustomerInput): Effect.Effect<Customer, InvalidInput | StorageFailure>;
  getById(id: string): Effect.Effect<Customer | undefined, StorageFailure>;
  list(): Effect.Effect<ReadonlyArray<Customer>, StorageFailure>;
}>()("zelavis/ecommerce/Customers") {
  static readonly layer = Layer.effect(
    Customers,
    Effect.gen(function* () {
      const { customers } = yield* Repositories;

      const create = Effect.fn("Customers.create")(function* (input: CreateCustomerInput) {
        for (const [field, value] of [["id", input.id], ["email", input.email]] as const) {
          if (!value) {
            return yield* new InvalidInput({
              field,
              message: `Customer creation requires ${field === "id" ? "an" : "a"} ${field}.`,
            });
          }
        }
        const now = new Date();
        return yield* customers.create({ ...input, createdAt: now, updatedAt: now } as Customer);
      });

      return Customers.of({
        create,
        getById: (id) => customers.findById(id),
        list: () => customers.list(),
      });
    }),
  );
}
