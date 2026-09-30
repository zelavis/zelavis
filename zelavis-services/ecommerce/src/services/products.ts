/**
 * Products.
 *
 * Named `Products` rather than `ProductService`: `Context.Service` and the
 * service id already say what it is, so the suffix only repeated the type.
 */
import { Context, Effect, Layer } from "effect";
import type { Product } from "../domain/entities.js";
import { InvalidInput, type StorageFailure } from "../errors.js";
import { Repositories } from "./repositories.js";

export interface CreateProductInput {
  id: string;
  slug: string;
  title: string;
  description?: string;
  price: Product["price"];
  metadata?: Record<string, unknown>;
}

export class Products extends Context.Service<Products, {
  create(input: CreateProductInput): Effect.Effect<Product, InvalidInput | StorageFailure>;
  getById(id: string): Effect.Effect<Product | undefined, StorageFailure>;
  list(): Effect.Effect<ReadonlyArray<Product>, StorageFailure>;
}>()("zelavis/ecommerce/Products") {
  static readonly layer = Layer.effect(
    Products,
    Effect.gen(function* () {
      const { products } = yield* Repositories;

      const create = Effect.fn("Products.create")(function* (input: CreateProductInput) {
        for (const [field, value] of [["id", input.id], ["slug", input.slug], ["title", input.title]] as const) {
          if (!value) {
            return yield* new InvalidInput({
              field,
              message: `Product creation requires a ${field}.`,
            });
          }
        }
        const now = new Date();
        return yield* products.create({ ...input, createdAt: now, updatedAt: now } as Product);
      });

      return Products.of({
        create,
        getById: (id) => products.findById(id),
        list: () => products.list(),
      });
    }),
  );
}
