/** Coupons, addressed by code rather than by id. */
import { Context, Effect, Layer } from "effect";
import type { Coupon } from "../domain/entities.js";
import { InvalidInput, type StorageFailure } from "../errors.js";
import { Repositories } from "./repositories.js";

export interface CreateCouponInput {
  code: string;
  description?: string;
  discountType: Coupon["discountType"];
  discountValue: number;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export class Coupons extends Context.Service<Coupons, {
  create(input: CreateCouponInput): Effect.Effect<Coupon, InvalidInput | StorageFailure>;
  getByCode(code: string): Effect.Effect<Coupon | undefined, StorageFailure>;
  list(): Effect.Effect<ReadonlyArray<Coupon>, StorageFailure>;
}>()("zelavis/ecommerce/Coupons") {
  static readonly layer = Layer.effect(
    Coupons,
    Effect.gen(function* () {
      const { coupons } = yield* Repositories;

      const create = Effect.fn("Coupons.create")(function* (input: CreateCouponInput) {
        if (!input.code) {
          return yield* new InvalidInput({ field: "code", message: "Coupon creation requires a code." });
        }
        if (input.discountValue < 0) {
          return yield* new InvalidInput({
            field: "discountValue",
            message: "Coupon discountValue must be zero or greater.",
          });
        }
        const now = new Date();
        return yield* coupons.create({
          ...input,
          active: input.active ?? true,
          createdAt: now,
          updatedAt: now,
        } as Coupon);
      });

      return Coupons.of({
        create,
        getByCode: (code) => coupons.findByCode(code),
        list: () => coupons.list(),
      });
    }),
  );
}
